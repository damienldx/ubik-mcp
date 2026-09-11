#!/usr/bin/env python3
"""Audit schema<->dispatcher coherence in a `bin/lba`-style CLI sibling.

These CLI siblings (bin/lba, bin/shamir, …) carry TWO separate sources of
truth for each tool: a `TOOLS = [...]` list of `{"name": ..., "inputSchema":
...}` dicts (what the LLM sees) and a big `if tool == "...": ...` dispatcher
inside `_exec()` (what actually runs). Nothing enforces that adding a name to
one adds it to the other — confirmed as a REAL, reproduced bug on 2026-09-11
(commit history bin/lba): three tool additions in the same session updated
only the schema, leaving Bacchus with parameters it could "see" but that were
silently dropped or a call that raised "tool inconnu" at execution time.

This script is the cheap fix for that specific failure class — not a
rewrite. Run after ANY edit to a CLI sibling's TOOLS list or dispatcher,
before committing:

    python3 scripts/audit_cli_dispatch_coverage.py [bin/lba] [bin/shamir ...]

No args = audits every `bin/*` file in this repo that has both a `TOOLS = [`
list and a `def _exec(` dispatcher. Exits 1 if any drift is found (schema
entry with no dispatcher branch, or dispatcher branch with no schema entry),
0 otherwise — safe to wire into a pre-commit hook or CI step.

Regex-based on purpose: importing bin/lba executes module-level code (network
clients, env reads) we don't want triggered by an audit script, and the
`TOOLS`/`_exec` shapes are simple and stable enough that a static scan is
both safe and sufficient — this is a coverage check, not a semantic linter.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_BIN_DIR = _REPO_ROOT / "bin"

_NAME_RE = re.compile(r'"name":\s*"([a-zA-Z0-9_]+)"')
# Two dispatch idioms seen in the wild: `tool == "x"` (most common) and
# `tool in ("x", "y", ...)` / `tool in {"x", "y", ...}` (grouped handler for
# several tool names sharing one branch, e.g. lba_calendar_accepter/refuser/
# accepter_provisoire). Both must be scanned or grouped dispatches read as
# false-positive "BROKEN" (confirmed 2026-09-11 on lba_calendar_accepter*).
_DISPATCH_EQ_RE = re.compile(r'tool\s*==\s*"([a-zA-Z0-9_]+)"')
_DISPATCH_IN_RE = re.compile(r'tool\s+in\s+[({](?P<body>[^)}]*)[)}]')
_QUOTED_NAME_RE = re.compile(r'"([a-zA-Z0-9_]+)"')
_TOOLS_START_RE = re.compile(r"^TOOLS\s*=\s*\[", re.MULTILINE)
_EXEC_START_RE = re.compile(r"^def _exec\(", re.MULTILINE)
_NEXT_TOPLEVEL_DEF_RE = re.compile(r"^def \w+\(", re.MULTILINE)


def _candidate_files() -> list[Path]:
    out = []
    for p in sorted(_BIN_DIR.iterdir()):
        if not p.is_file():
            continue
        text = p.read_text(errors="replace")
        if _TOOLS_START_RE.search(text) and _EXEC_START_RE.search(text):
            out.append(p)
    return out


def _extract_schema_names(text: str) -> set[str]:
    start = _TOOLS_START_RE.search(text)
    if not start:
        return set()
    # TOOLS = [ ... ] closes at the first top-level "]" on its own line
    # (the list is always the first module-level statement of that shape).
    close = re.search(r"^\]\s*$", text[start.end():], re.MULTILINE)
    end = start.end() + (close.start() if close else len(text) - start.end())
    return set(_NAME_RE.findall(text[start.start():end]))


def _extract_dispatch_names(text: str) -> set[str]:
    start = _EXEC_START_RE.search(text)
    if not start:
        return set()
    nxt = _NEXT_TOPLEVEL_DEF_RE.search(text, start.end())
    end = nxt.start() if nxt else len(text)
    body = text[start.start():end]
    names = set(_DISPATCH_EQ_RE.findall(body))
    for m in _DISPATCH_IN_RE.finditer(body):
        names |= set(_QUOTED_NAME_RE.findall(m.group("body")))
    return names


def audit_file(path: Path) -> bool:
    """Returns True if clean (no drift)."""
    text = path.read_text(errors="replace")
    schema_names = _extract_schema_names(text)
    dispatch_names = _extract_dispatch_names(text)

    schema_only = sorted(schema_names - dispatch_names)
    dispatch_only = sorted(dispatch_names - schema_names)

    print(f"\n=== {path.relative_to(_REPO_ROOT)} — {len(schema_names)} schema, {len(dispatch_names)} dispatch ===")

    if not schema_only and not dispatch_only:
        print("  OK — parity")
        return True

    if schema_only:
        print(f"  BROKEN ({len(schema_only)}) — schema exists, no dispatcher branch (LLM sees a tool that fails on call):")
        for n in schema_only:
            print(f"    - {n}")
    if dispatch_only:
        print(f"  HIDDEN ({len(dispatch_only)}) — dispatcher works, no schema entry (invisible to the LLM):")
        for n in dispatch_only:
            print(f"    - {n}")
    return False


def main() -> int:
    args = sys.argv[1:]
    files = [Path(a).resolve() for a in args] if args else _candidate_files()
    if not files:
        print("no bin/* file with both TOOLS=[...] and def _exec( found", file=sys.stderr)
        return 1

    clean = True
    for f in files:
        if not audit_file(f):
            clean = False

    print()
    print("all clean" if clean else "drift found — fix before committing (see BROKEN/HIDDEN above)")
    return 0 if clean else 1


if __name__ == "__main__":
    sys.exit(main())
