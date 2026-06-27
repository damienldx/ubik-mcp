#!/usr/bin/env python3
"""
ubik-workspace MCP server — standalone stdio JSON-RPC.

Tools:
  agent_workspace_create(repo_url?, branch_name?, agent_id?, vm?, docker_image?)
      - repo_url given  -> REPO mode: clone repo on a new branch (local or VM)
      - repo_url omitted -> BARE SANDBOX mode: fresh disposable VM container, no repo
  agent_workspace_exec(registry_id, command)
  agent_workspace_finish(registry_id, pr_title, pr_body)   # repo workspaces only
  agent_workspace_status(agent_id?)
  agent_workspace_abandon(registry_id)
  agent_workspace_prepull()

Storage: ~/.ubik-workspace/registry.db (SQLite)
Local workspaces: /tmp/agent-ws-<short_uuid>
VM workspaces: dev-station-02:/tmp/agent-ws-<short_uuid>
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import sqlite3
import subprocess
import sys
import uuid
from pathlib import Path
from urllib.parse import urlparse

REGISTRY_DIR = Path.home() / ".ubik-workspace"
REGISTRY_DB = REGISTRY_DIR / "registry.db"

# Autopipes registry — curated persona whitelist (étape 5, 2026-06-27).
_AUTOPIPES_REGISTRY = Path.home() / ".ubik-memory" / "autopipes" / "library" / "registry.yaml"
_registry_persona_ids: set[str] | None = None


def _load_registry_persona_ids() -> set[str]:
    """Load curated persona IDs from registry.yaml. Cached after first load."""
    global _registry_persona_ids
    if _registry_persona_ids is not None:
        return _registry_persona_ids
    ids: set[str] = set()
    try:
        import yaml  # type: ignore
        if _AUTOPIPES_REGISTRY.exists():
            with open(_AUTOPIPES_REGISTRY) as f:
                reg = yaml.safe_load(f)
            ids = {p["id"] for p in (reg.get("personas") or []) if p.get("id")}
    except Exception:
        # yaml not installed: minimal line-regex fallback
        try:
            if _AUTOPIPES_REGISTRY.exists():
                in_personas = False
                for line in _AUTOPIPES_REGISTRY.read_text().splitlines():
                    if line.startswith("personas:"):
                        in_personas = True
                        continue
                    if in_personas and line and not line[0].isspace():
                        in_personas = False
                    if in_personas:
                        import re as _re
                        m = _re.search(r"\bid\s*:\s*[\"']?([a-z0-9_-]+)[\"']?", line)
                        if m:
                            ids.add(m.group(1))
        except Exception:
            pass
    _registry_persona_ids = ids
    return ids
WORKSPACE_ROOT = Path("/tmp")
WORKSPACE_PREFIX = "agent-ws-"

VM_HOST = "dev-station-02"
VM_WORKSPACE_ROOT = "/tmp"

# Auto-detect: if we're already on the VM, run Docker commands locally (no SSH to self).
import socket as _socket
_ON_VM = _socket.gethostname().startswith("dev-station-02")

DOCKER_IMAGES = [
    "python:3.11-slim",
    "node:20-alpine",
    "ubuntu:22.04",
    "postgres:16-alpine",
]

REPO_URL_RE = re.compile(r"^https://github\.com/[\w.-]+/[\w.-]+(\.git)?$")
BRANCH_RE = re.compile(r"^[a-zA-Z0-9/_.-]+$")


def _db() -> sqlite3.Connection:
    REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(REGISTRY_DB)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS workspace_registry (
            id            TEXT PRIMARY KEY,
            agent_id      TEXT,
            repo_url      TEXT NOT NULL,
            branch        TEXT NOT NULL,
            path          TEXT NOT NULL,
            status        TEXT NOT NULL DEFAULT 'active',
            pr_url        TEXT,
            vm_mode       INTEGER NOT NULL DEFAULT 0,
            container_id  TEXT,
            docker_image  TEXT,
            created_at    TEXT NOT NULL DEFAULT (datetime('now')),
            finished_at   TEXT
        )
        """
    )
    # Migrate existing tables that lack the new columns
    for col, definition in [
        ("vm_mode", "INTEGER NOT NULL DEFAULT 0"),
        ("container_id", "TEXT"),
        ("docker_image", "TEXT"),
        ("bare", "INTEGER NOT NULL DEFAULT 0"),
    ]:
        try:
            conn.execute(f"ALTER TABLE workspace_registry ADD COLUMN {col} {definition}")
        except sqlite3.OperationalError:
            pass  # column already exists
    conn.commit()
    return conn


def _run(cmd: list[str], cwd: str | None = None) -> tuple[int, str, str]:
    p = subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=120,
        env=os.environ.copy(),
    )
    return p.returncode, p.stdout, p.stderr


def _run_ssh(cmd: str, timeout: int = 120) -> tuple[int, str, str]:
    """Run a command on the VM. If already on the VM, run locally."""
    if _ON_VM:
        return _run(["bash", "-c", cmd], cwd=None)
    p = subprocess.run(
        ["ssh", VM_HOST, cmd],
        capture_output=True,
        text=True,
        timeout=timeout,
        env=os.environ.copy(),
    )
    return p.returncode, p.stdout, p.stderr


def _branch_has_unpushed_commits(cwd: str, branch: str, vm: bool = False) -> bool:
    if vm:
        rc, out, _ = _run_ssh(f"git -C {cwd} rev-list --count origin/{branch}..HEAD 2>/dev/null || echo 1")
    else:
        rc, out, _ = _run(["git", "rev-list", "--count", f"origin/{branch}..HEAD"], cwd=cwd)
    if rc != 0:
        return True
    try:
        return int(out.strip()) > 0
    except ValueError:
        return True


def _derive_repo_slug(repo_url: str) -> str:
    path = urlparse(repo_url).path.strip("/")
    if path.endswith(".git"):
        path = path[:-4]
    return path


# ── Local workspace ───────────────────────────────────────────────

def _create_local(reg_id: str, short: str, repo_url: str, branch_name: str, agent_id: str | None) -> dict:
    path = WORKSPACE_ROOT / f"{WORKSPACE_PREFIX}{short}"

    rc, _, err = _run(["git", "clone", "--depth", "50", repo_url, str(path)])
    if rc != 0:
        return {"error": f"git clone failed: {err.strip()}"}

    rc, _, err = _run(["git", "checkout", "-b", branch_name], cwd=str(path))
    if rc != 0:
        shutil.rmtree(path, ignore_errors=True)
        return {"error": f"git checkout -b failed: {err.strip()}"}

    conn = _db()
    conn.execute(
        "INSERT INTO workspace_registry (id, agent_id, repo_url, branch, path, status, vm_mode) VALUES (?,?,?,?,?,?,0)",
        (reg_id, agent_id, repo_url, branch_name, str(path), "active"),
    )
    conn.commit()
    conn.close()

    return {
        "registry_id": reg_id,
        "path": str(path),
        "repo_slug": _derive_repo_slug(repo_url),
        "branch": branch_name,
        "vm": False,
        "instructions": f"cd {path} and work there. NEVER edit outside this directory.",
    }


# ── VM workspace ──────────────────────────────────────────────────

def _create_vm(reg_id: str, short: str, repo_url: str, branch_name: str, agent_id: str | None, docker_image: str, bare: bool = False) -> dict:
    path = f"{VM_WORKSPACE_ROOT}/{WORKSPACE_PREFIX}{short}"
    container_name = f"{WORKSPACE_PREFIX}{short}"

    if bare:
        rc, _, err = _run_ssh(f"mkdir -p {path}")
        if rc != 0:
            return {"error": f"mkdir on VM failed: {err.strip()}"}
    else:
        rc, _, err = _run_ssh(f"git clone --depth 50 {repo_url} {path}")
        if rc != 0:
            return {"error": f"git clone on VM failed: {err.strip()}"}

        rc, _, err = _run_ssh(f"git -C {path} checkout -b {branch_name}")
        if rc != 0:
            _run_ssh(f"rm -rf {path}")
            return {"error": f"git checkout -b on VM failed: {err.strip()}"}

    rc, out, err = _run_ssh(
        f"docker run -d --name {container_name} -v {path}:/workspace -w /workspace {docker_image} sleep infinity"
    )
    if rc != 0:
        _run_ssh(f"rm -rf {path}")
        return {"error": f"docker run on VM failed: {err.strip()}"}

    container_id = out.strip()

    conn = _db()
    conn.execute(
        "INSERT INTO workspace_registry (id, agent_id, repo_url, branch, path, status, vm_mode, container_id, docker_image, bare) VALUES (?,?,?,?,?,?,1,?,?,?)",
        (reg_id, agent_id, repo_url, branch_name, path, "active", container_id, docker_image, 1 if bare else 0),
    )
    conn.commit()
    conn.close()

    result = {
        "registry_id": reg_id,
        "path": path,
        "vm": True,
        "vm_host": VM_HOST,
        "container": container_name,
        "docker_image": docker_image,
        "bare": bare,
    }
    if bare:
        result["instructions"] = (
            f"Bare sandbox on VM {VM_HOST}: fresh disposable Docker container '{container_name}' ({docker_image}), "
            f"no repo cloned. Use agent_workspace_exec to run anything — destructive tests are fine, the container "
            f"is fully throwaway. Destroy it with agent_workspace_abandon (agent_workspace_finish does not apply)."
        )
    else:
        result["repo_slug"] = _derive_repo_slug(repo_url)
        result["branch"] = branch_name
        result["instructions"] = (
            f"Workspace is on VM {VM_HOST} at {path}, inside Docker container '{container_name}'. "
            f"Use agent_workspace_exec to run commands. NEVER edit outside this workspace."
        )
    return result


# ── Tools ─────────────────────────────────────────────────────────

def tool_create(args: dict) -> dict:
    repo_url = (args.get("repo_url") or "").strip()
    branch_name = (args.get("branch_name") or "").strip()
    agent_id = args.get("agent_id")
    vm = bool(args.get("vm", False))
    docker_image = (args.get("docker_image") or "ubuntu:22.04").strip()

    reg_id = uuid.uuid4().hex[:12]
    short = uuid.uuid4().hex[:8]

    # Bare sandbox mode: no repo → fresh disposable container. exec is VM-only, so force vm.
    if not repo_url:
        return _create_vm(
            reg_id, short, "(bare-sandbox)", branch_name or "(none)",
            agent_id, docker_image, bare=True,
        )

    if not REPO_URL_RE.match(repo_url):
        return {"error": f"invalid repo_url (must be https://github.com/owner/repo, or omit it for a bare sandbox): {repo_url}"}
    if not BRANCH_RE.match(branch_name) or len(branch_name) > 200:
        return {"error": f"invalid branch_name: {branch_name}"}

    if vm:
        return _create_vm(reg_id, short, repo_url, branch_name, agent_id, docker_image)
    return _create_local(reg_id, short, repo_url, branch_name, agent_id)


def tool_exec(args: dict) -> dict:
    reg_id = args.get("registry_id", "").strip()
    command = args.get("command", "").strip()

    if not reg_id or not command:
        return {"error": "registry_id and command required"}

    conn = _db()
    row = conn.execute(
        "SELECT path, status, vm_mode, container_id FROM workspace_registry WHERE id=?",
        (reg_id,),
    ).fetchone()
    conn.close()

    if not row:
        return {"error": f"registry_id not found: {reg_id}"}
    path, status, vm_mode, _container_id = row
    if status != "active":
        return {"error": f"workspace is {status}, cannot exec"}

    if not vm_mode:
        return {"error": "agent_workspace_exec is only available for VM workspaces (vm=True)"}

    container_name = Path(path).name  # agent-ws-{short}
    escaped = command.replace("'", "'\\''")
    rc, stdout, stderr = _run_ssh(f"docker exec {container_name} bash -c '{escaped}'", timeout=300)

    return {
        "exit_code": rc,
        "stdout": stdout,
        "stderr": stderr,
        "ok": rc == 0,
    }


def tool_finish(args: dict) -> dict:
    reg_id = args.get("registry_id", "").strip()
    pr_title = args.get("pr_title", "").strip()
    pr_body = args.get("pr_body", "")

    if not reg_id or not pr_title:
        return {"error": "registry_id and pr_title required"}

    conn = _db()
    row = conn.execute(
        "SELECT repo_url, branch, path, status, vm_mode, bare FROM workspace_registry WHERE id=?",
        (reg_id,),
    ).fetchone()
    if not row:
        conn.close()
        return {"error": f"registry_id not found: {reg_id}"}
    repo_url, branch, path, status, vm_mode, bare = row
    if status != "active":
        conn.close()
        return {"error": f"workspace already {status}"}
    if bare:
        conn.close()
        return {"error": "bare sandbox has no repo/branch to push; use agent_workspace_abandon to destroy it"}

    if vm_mode:
        result = _finish_vm(reg_id, repo_url, branch, path, pr_title, pr_body, conn)
    else:
        result = _finish_local(reg_id, repo_url, branch, path, pr_title, pr_body, conn)

    return result


def _finish_local(reg_id, repo_url, branch, path, pr_title, pr_body, conn) -> dict:
    rc, out, _ = _run(["git", "status", "--porcelain"], cwd=path)
    if rc == 0 and out.strip():
        conn.close()
        return {"error": f"workspace has uncommitted changes:\n{out}"}

    fetch_rc, _, _ = _run(["git", "fetch", "origin", branch], cwd=path)
    needs_push = fetch_rc != 0 or _branch_has_unpushed_commits(path, branch)

    if needs_push:
        rc, push_out, push_err = _run(["git", "push", "-u", "origin", branch], cwd=path)
        if rc != 0:
            if any(k in push_err.lower() for k in ("stale info", "non-fast-forward", "rejected")):
                rc, push_out, push_err = _run(["git", "push", "--force-with-lease", "-u", "origin", branch], cwd=path)
            if rc != 0:
                conn.close()
                return {"error": "git push failed", "stderr": push_err.strip(), "stdout": push_out.strip()}

    return _open_pr_and_cleanup_local(reg_id, repo_url, branch, path, pr_title, pr_body, conn)


def _finish_vm(reg_id, repo_url, branch, path, pr_title, pr_body, conn) -> dict:
    container_name = Path(path).name

    rc, out, _ = _run_ssh(f"git -C {path} status --porcelain")
    if rc == 0 and out.strip():
        conn.close()
        return {"error": f"workspace has uncommitted changes on VM:\n{out}"}

    _run_ssh(f"git -C {path} fetch origin {branch}")
    needs_push = _branch_has_unpushed_commits(path, branch, vm=True)

    if needs_push:
        rc, _, push_err = _run_ssh(f"git -C {path} push -u origin {branch}")
        if rc != 0:
            rc, _, push_err = _run_ssh(f"git -C {path} push --force-with-lease -u origin {branch}")
            if rc != 0:
                conn.close()
                return {"error": "git push on VM failed", "stderr": push_err.strip()}

    # PR is created from local (gh is authenticated here)
    repo_slug = _derive_repo_slug(repo_url)
    pr_url = None
    rc, out, _ = _run(["gh", "pr", "list", "--repo", repo_slug, "--head", branch, "--json", "url", "--jq", ".[0].url // empty"])
    if rc == 0 and out.strip():
        pr_url = out.strip()

    if not pr_url:
        rc, out, err = _run(["gh", "pr", "create", "--repo", repo_slug, "--head", branch, "--title", pr_title, "--body", pr_body or pr_title])
        if rc != 0:
            conn.close()
            return {"error": "gh pr create failed", "stderr": err.strip(), "branch_pushed": branch}
        pr_url = out.strip().splitlines()[-1] if out.strip() else None

    # Cleanup VM: stop container + delete directory
    _run_ssh(f"docker rm -f {container_name}")
    _run_ssh(f"rm -rf {path}")

    conn.execute(
        "UPDATE workspace_registry SET status='finished', pr_url=?, finished_at=datetime('now') WHERE id=?",
        (pr_url, reg_id),
    )
    conn.commit()
    conn.close()

    return {"pr_url": pr_url, "branch_pushed": branch, "cleaned": True, "vm": True}


def _open_pr_and_cleanup_local(reg_id, repo_url, branch, path, pr_title, pr_body, conn) -> dict:
    repo_slug = _derive_repo_slug(repo_url)
    pr_url = None
    rc, out, _ = _run(["gh", "pr", "list", "--repo", repo_slug, "--head", branch, "--json", "url", "--jq", ".[0].url // empty"], cwd=path)
    if rc == 0 and out.strip():
        pr_url = out.strip()

    if not pr_url:
        rc, out, err = _run(["gh", "pr", "create", "--repo", repo_slug, "--head", branch, "--title", pr_title, "--body", pr_body or pr_title], cwd=path)
        if rc != 0:
            conn.close()
            return {
                "error": "gh pr create failed",
                "stderr": err.strip(),
                "stdout": out.strip(),
                "branch_pushed": branch,
                "hint": "Verify gh is authenticated: `gh auth status`.",
            }
        pr_url = out.strip().splitlines()[-1] if out.strip() else None

    shutil.rmtree(path, ignore_errors=True)
    conn.execute(
        "UPDATE workspace_registry SET status='finished', pr_url=?, finished_at=datetime('now') WHERE id=?",
        (pr_url, reg_id),
    )
    conn.commit()
    conn.close()

    return {"pr_url": pr_url, "branch_pushed": branch, "cleaned": True, "vm": False}


def tool_status(args: dict) -> dict:
    agent_id = args.get("agent_id")
    conn = _db()
    if agent_id:
        rows = conn.execute(
            "SELECT id, agent_id, repo_url, branch, path, status, pr_url, vm_mode, docker_image, bare, created_at FROM workspace_registry WHERE status='active' AND agent_id=? ORDER BY created_at DESC",
            (agent_id,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT id, agent_id, repo_url, branch, path, status, pr_url, vm_mode, docker_image, bare, created_at FROM workspace_registry WHERE status='active' ORDER BY created_at DESC"
        ).fetchall()
    conn.close()
    keys = ["registry_id", "agent_id", "repo_url", "branch", "path", "status", "pr_url", "vm", "docker_image", "bare", "created_at"]
    return {"active_workspaces": [dict(zip(keys, r)) for r in rows]}


def tool_abandon(args: dict) -> dict:
    reg_id = args.get("registry_id", "").strip()
    if not reg_id:
        return {"error": "registry_id required"}

    conn = _db()
    row = conn.execute(
        "SELECT path, branch, repo_url, status, vm_mode, bare FROM workspace_registry WHERE id=?",
        (reg_id,),
    ).fetchone()
    if not row:
        conn.close()
        return {"error": f"registry_id not found: {reg_id}"}
    path, branch, repo_url, status, vm_mode, bare = row
    if status != "active":
        conn.close()
        return {"error": f"workspace already {status}"}

    if vm_mode:
        container_name = Path(path).name
        _run_ssh(f"docker rm -f {container_name}")
        _run_ssh(f"rm -rf {path}")
    elif Path(path).exists():
        shutil.rmtree(path, ignore_errors=True)
    # best-effort delete remote branch (repo workspaces only — bare sandboxes have none)
    if not bare:
        _run(["git", "push", repo_url, "--delete", branch])

    conn.execute(
        "UPDATE workspace_registry SET status='abandoned', finished_at=datetime('now') WHERE id=?",
        (reg_id,),
    )
    conn.commit()
    conn.close()
    return {"abandoned": reg_id, "cleaned_path": path, "vm": bool(vm_mode)}


def tool_suggest(args: dict) -> dict:
    """Query QUBIK on the VM for relevant tools and skills. Zero LLM cost — FTS5 only."""
    query = args.get("query", "").strip()
    limit = int(args.get("limit", 5))
    agent_id = (args.get("agent_id") or os.environ.get("UBIK_AGENT_ID") or "").strip()
    if not query:
        return {"error": "query required"}

    # Thread agent_id through to qubik_search.py so the call is attributed to the
    # calling slot in qubik_query_log (without it the row logs as unknown/NULL).
    # shlex.quote (not json.dumps): json.dumps defaults to ensure_ascii=True, which
    # escapes non-ASCII (é -> é) so the query is LOGGED escaped in query_text,
    # while qubik_record_usage searches the raw query -> never matches. shlex.quote
    # preserves unicode + apostrophes verbatim and is injection-safe. (LOT2 L4 fix #2)
    agent_flag = f" --agent {shlex.quote(agent_id)}" if agent_id else ""
    script = (
        f"cd ~/workspace/UBIK-ENGINE && "
        f"python3 qubik_search.py {shlex.quote(query)} {limit}{agent_flag} 2>/dev/null"
    )
    rc, stdout, stderr = _run_ssh(script, timeout=15)
    if rc != 0:
        return {"error": f"qubik_search failed: {stderr.strip()}"}

    # stdout may have log lines before JSON — find the JSON line
    for line in stdout.strip().splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                result = json.loads(line)
                # Étape 5 (2026-06-27): filter agents to registry whitelist only.
                # Tools and skills are from the tool catalog (not data/agents/*.md) — untouched.
                if isinstance(result.get("agents"), list):
                    curated = _load_registry_persona_ids()
                    if curated:
                        result["agents"] = [
                            a for a in result["agents"] if a.get("id") in curated
                        ]
                        result["_registry_filter"] = f"{len(curated)} curated personas"
                return result
            except json.JSONDecodeError:
                pass

    return {"error": "no JSON output from qubik_search", "raw": stdout[:500]}


def tool_record_usage(args: dict) -> dict:
    """Record which tool was actually used after a qubik_suggest.

    Delegates to qubik_record_usage.py on the VM, which matches the most recent
    qubik_query_log row by its NORMALIZED key (normalize_query) — the SAME key
    qubik_search.py logs. This is symmetric by construction: emoji, unicode form,
    case and any escaping introduced in transit no longer break the match.

    Previously this ran inline SQL matching on the RAW query_text, while
    qubik_suggest had logged the query escaped ("—" → literal "\\u2014") via an
    upstream ensure_ascii=True serializer → 0 rows, recorded:false, feedback loop
    silently dead (bug t_533ca5381f). Both sides now share normalize_query().
    """
    tool_name = args.get("tool_name", "").strip()
    query = args.get("query", "").strip()
    agent_id = (args.get("agent_id") or os.environ.get("UBIK_AGENT_ID") or "").strip()
    if not tool_name:
        return {"error": "tool_name required"}
    if not query:
        return {"error": "query required (the same query used in qubik_suggest)"}

    # shlex.quote (not json.dumps) keeps unicode + apostrophes verbatim into argv;
    # the script normalizes both stored and incoming query identically.
    agent_flag = f" --agent {shlex.quote(agent_id)}" if agent_id else ""
    script = (
        "cd ~/workspace/UBIK-ENGINE && UBIK_DATA_DIR=/home/damienldx/.ubik-engine "
        "python3 qubik_record_usage.py "
        + f"{shlex.quote(tool_name)} {shlex.quote(query)}{agent_flag} 2>/dev/null"
    )
    rc, stdout, stderr = _run_ssh(script, timeout=10)
    if rc != 0:
        return {"error": f"record_usage failed: {stderr.strip()}"}

    # stdout may have log lines before JSON — find the JSON line (mirrors tool_suggest)
    for line in stdout.strip().splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                pass
    return {"error": "no JSON output from qubik_record_usage", "raw": stdout[:500]}


def tool_prepull(_args: dict) -> dict:
    """Pull Docker images on the VM in the background. Safe to call at DESKTOP startup."""
    results = {}
    for image in DOCKER_IMAGES:
        rc, _, err = _run_ssh(f"docker pull {image} 2>&1 | tail -1", timeout=300)
        results[image] = "ok" if rc == 0 else f"error: {err.strip()}"
    return {"prepull": results}


TOOLS = {
    "agent_workspace_create":  tool_create,
    "agent_workspace_exec":    tool_exec,
    "agent_workspace_finish":  tool_finish,
    "agent_workspace_status":  tool_status,
    "agent_workspace_abandon": tool_abandon,
    "agent_workspace_prepull": tool_prepull,
    "qubik_suggest":           tool_suggest,
    "qubik_record_usage":      tool_record_usage,
}

TOOL_SCHEMAS = [
    {
        "name": "agent_workspace_create",
        "description": (
            "Create an isolated workspace. Two modes:\n"
            "• REPO mode (pass repo_url + branch_name): clones a GitHub repo on a new branch. "
            "ALWAYS use this before editing code in a Git project. With vm=true the clone+container live on dev-station-02.\n"
            "• BARE SANDBOX mode (omit repo_url): spins up a fresh, fully disposable Docker container on dev-station-02 "
            "with NO repo — for destructive tests, bug reproduction, build matrices, or trying anything risky in isolation. "
            "Always VM-backed. Destroy it with agent_workspace_abandon (agent_workspace_finish does not apply).\n"
            "In both VM cases, use agent_workspace_exec to run commands autonomously."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "repo_url":     {"type": "string", "description": "https://github.com/owner/repo URL. OMIT for a bare disposable sandbox (no repo cloned)."},
                "branch_name":  {"type": "string", "description": "name of the new branch (created from origin/main). Ignored in bare-sandbox mode."},
                "agent_id":     {"type": "string", "description": "optional agent identifier for tracking"},
                "vm":           {"type": "boolean", "description": "if true, create workspace on VM with Docker (recommended for autonomous testing). Forced true in bare-sandbox mode."},
                "docker_image": {"type": "string", "description": "Docker image to use (default: ubuntu:22.04). Pre-pulled (sub-500ms start): python:3.11-slim, node:20-alpine, ubuntu:22.04, postgres:16-alpine. Any other image works too — pulled on demand on first use."},
            },
            "required": [],
        },
    },
    {
        "name": "agent_workspace_exec",
        "description": (
            "Run a shell command inside the Docker container of a VM workspace. "
            "Returns stdout, stderr, and exit_code. Use to install deps, run tests, build, etc. "
            "Only available for workspaces created with vm=true."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "registry_id": {"type": "string", "description": "the registry_id returned by agent_workspace_create"},
                "command":     {"type": "string", "description": "shell command to run inside the container (bash -c)"},
            },
            "required": ["registry_id", "command"],
        },
    },
    {
        "name": "agent_workspace_finish",
        "description": "Push the branch to origin, open a PR, then destroy the workspace (Docker container + directory on VM, or local /tmp). Use when the agent's work is committed and ready for human review.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "registry_id": {"type": "string", "description": "the registry_id returned by agent_workspace_create"},
                "pr_title":    {"type": "string", "description": "PR title (concise, imperative)"},
                "pr_body":     {"type": "string", "description": "PR body (markdown)"},
            },
            "required": ["registry_id", "pr_title"],
        },
    },
    {
        "name": "agent_workspace_status",
        "description": "List active workspaces (optionally filtered by agent_id). Shows whether each workspace is VM-based or local.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "agent_id": {"type": "string", "description": "optional filter by agent"},
            },
        },
    },
    {
        "name": "agent_workspace_abandon",
        "description": "Destroy the workspace without opening a PR (Docker rm + rm -rf on VM, or local /tmp cleanup). Use when work is blocked or no longer needed.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "registry_id": {"type": "string"},
            },
            "required": ["registry_id"],
        },
    },
    {
        "name": "agent_workspace_prepull",
        "description": "Pre-pull standard Docker images on the VM so container cold-start is under 500ms. Call once at DESKTOP startup. Images: python:3.11-slim, node:20-alpine, ubuntu:22.04, postgres:16-alpine.",
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "qubik_suggest",
        "description": (
            "Query QUBIK to find the most relevant tools and skills for a given task. "
            "Semantic search (768-dim embeddings, KNN cosine) on 23K+ skills and 553 tools, "
            "with FTS5 fallback. Zero LLM cost. "
            "Call this BEFORE starting any complex task to discover which tools to use. "
            "Returns ranked tools (with their MCP server) and relevant skills (personas to adopt). "
            "Each call is logged for the feedback loop — see qubik_record_usage to teach the system "
            "which tool you actually used."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Describe what you want to accomplish"},
                "limit": {"type": "integer", "description": "Max number of tools to return (default: 5)"},
                "agent_id": {"type": "string", "description": "Calling slot id (e.g. '6da176c2-agent-7'). Attributes the query to this slot in qubik_query_log; omit and it logs as unknown."},
            },
            "required": ["query"],
        },
    },
    {
        "name": "qubik_record_usage",
        "description": (
            "Tell QUBIK which tool you actually used after a qubik_suggest call. "
            "This feeds the feedback loop: tools used after being suggested get a rank boost "
            "on semantically similar future queries. Pass the SAME query string you used in qubik_suggest "
            "(or a close variant). Best-effort, never fails the agent's flow."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "tool_name": {"type": "string", "description": "Name of the tool actually used (e.g. 'agent_workspace_create')"},
                "query": {"type": "string", "description": "The query you originally passed to qubik_suggest"},
                "agent_id": {"type": "string", "description": "Calling slot id (e.g. '6da176c2-agent-7'). Scopes the tool_used update to this slot's row."},
            },
            "required": ["tool_name", "query"],
        },
    },
]


# ── MCP stdio JSON-RPC loop ────────────────────────────────────────

def _send(msg: dict) -> None:
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def _result(req_id, result) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _error(req_id, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


def handle(req: dict) -> dict | None:
    method = req.get("method")
    req_id = req.get("id")
    params = req.get("params") or {}

    if method == "initialize":
        return _result(req_id, {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "ubik-workspace", "version": "0.3.0"},
        })

    if method == "notifications/initialized":
        return None

    if method == "tools/list":
        return _result(req_id, {"tools": TOOL_SCHEMAS})

    if method == "tools/call":
        name = params.get("name") or ""
        args = params.get("arguments") or {}
        fn = TOOLS.get(name)
        if not fn:
            return _error(req_id, -32601, f"unknown tool: {name}")
        try:
            out = fn(args)
            return _result(req_id, {"content": [{"type": "text", "text": json.dumps(out, indent=2)}]})
        except Exception as e:
            return _error(req_id, -32000, f"tool error: {e}")

    if method in ("ping",):
        return _result(req_id, {})

    return _error(req_id, -32601, f"method not found: {method}")


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        resp = handle(req)
        if resp is not None:
            _send(resp)


if __name__ == "__main__":
    main()
