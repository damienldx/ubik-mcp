#!/usr/bin/env python3
"""
backfill_native_prompts.py - Generate missing autoskill prompt.md/skill.json
for UBIK Native skills that exist in data/skills-seed.json but were never
processed by `ubik-autoskill`.

Usage:
    backfill_native_prompts.py                      # backfill all missing
    backfill_native_prompts.py --limit 5            # try on 5 ids first
    backfill_native_prompts.py --burst 8            # 8 concurrent ENGINE calls
    backfill_native_prompts.py --ids id1,id2,id3    # specific ids
    backfill_native_prompts.py --dry-run            # list ids, no LLM calls
    backfill_native_prompts.py --verbose            # show ENGINE responses

Idempotent: ids whose prompt.md already exists (non-empty) are skipped.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import httpx

REPO_ROOT       = Path(__file__).parent.parent
SKILLS_JSON     = REPO_ROOT / "data" / "skills-seed.json"
USER_SKILLS_DIR = Path.home() / ".ubik-autoskill"
ENGINE_URL      = "http://localhost:8801"
MODEL           = "gemini-2.5-flash-lite"
DOMAIN          = "UBIK Native"

# Mirrors ubik-autoskill main.py KNOWN_TOOLS - keep in sync.
KNOWN_TOOLS = {
    "agent_kill", "agent_list", "agent_result", "agent_spawn", "agent_status",
    "analyze_data", "analyze_db_schema", "calendar_create", "calendar_delete",
    "calendar_list", "calendar_update", "code_review", "connector_status",
    "crawl_extract", "crawl_map", "crawl_search", "crawl_site", "crawl_url",
    "create_html_artifact", "drive_read", "drive_search", "drive_upload",
    "edit_file", "file_outline", "find_files", "github_create_issue",
    "github_create_pr", "github_get_file", "github_list_issues",
    "github_list_prs", "github_list_repos", "github_search_code",
    "gmail_read", "gmail_search", "gmail_send", "list_directory", "ocr_extract",
    "onedrive_read", "onedrive_search", "outlook_read", "outlook_search",
    "outlook_send", "read_context", "read_database", "read_file",
    "recall_context", "review_diff", "review_file", "review_pr",
    "review_security", "run_command", "run_shell_command", "save_context",
    "search_files", "skill_search", "transcribe_audio", "web_search",
    "whatsapp_send", "write_file",
}

SYSTEM_PROMPT_TEMPLATE = """Tu generes un system prompt UBIK pour un skill decrit ci-dessous. Reponds UNIQUEMENT avec le JSON brut, PAS de markdown, PAS de tool call.

Format strict:
{{
  "icon": "<emoji>",
  "examples": ["question 1", "question 2", "question 3"],
  "tools": ["read_file", "..."],
  "prompt": "<system prompt complet>"
}}

Regles pour `prompt` (le coeur du livrable):
1. PERSONA NOMMEE: "Tu es <Nom>, expert en <domaine>." (utilise le nom et la description fournis).
2. ROLE OPERATIONNEL: ce que l'agent fait concretement avec les fichiers/outils/commandes reels.
3. PROTOCOLE D'ACTION: etapes numerotees et precises.
4. CONTRE-INDICATION: "Ne jamais..." ou "Avant X, toujours Y".
5. FORMAT DE SORTIE: structure attendue de la reponse.
Longueur 6-10 paragraphes. Concret, zero remplissage marketing.

Autres regles:
- tools: UNIQUEMENT parmi: {tools_list}
- examples: 3 questions exemples qu'un utilisateur pourrait poser a ce skill.
- icon: un seul emoji representatif.
- JSON strict, pas de commentaires, pas de fences.
"""

SYSTEM_PROMPT = SYSTEM_PROMPT_TEMPLATE.format(tools_list=", ".join(sorted(KNOWN_TOOLS)))


def call_engine(skill: dict, verbose: bool = False) -> dict | None:
    user_msg = (
        f"Nom: {skill['name']}\n"
        f"Description: {skill.get('description', '')}\n"
        f"Tags: {', '.join(skill.get('tags', []))}"
    )
    try:
        resp = httpx.post(
            f"{ENGINE_URL}/v1/chat/completions",
            json={
                "model": MODEL,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_msg},
                ],
                "temperature": 0.3,
                "max_tokens": 1500,
                "stream": False,
            },
            timeout=120,
        )
    except Exception as e:
        print(f"  [LLM] {skill['id']}: {e}", file=sys.stderr)
        return None

    if resp.status_code != 200:
        print(f"  [LLM] {skill['id']}: HTTP {resp.status_code}: {resp.text[:200]}", file=sys.stderr)
        return None

    body = resp.text.strip()
    content = ""
    if body.startswith("data:"):
        for line in body.splitlines():
            if not line.startswith("data:") or "[DONE]" in line:
                continue
            try:
                evt = json.loads(line[5:])
                if evt.get("type") == "token":
                    content += evt["choices"][0]["delta"].get("content", "")
            except (json.JSONDecodeError, KeyError, IndexError):
                pass
    else:
        try:
            data = json.loads(body)
            content = data["choices"][0]["message"]["content"]
        except (json.JSONDecodeError, KeyError, IndexError):
            return None

    if verbose:
        print(f"  [LLM raw {len(content)} chars] {content[:200]}...", file=sys.stderr)

    if not content:
        return None

    clean = re.sub(r"^```[a-z]*\n?", "", content.strip(), flags=re.MULTILINE)
    clean = re.sub(r"```$", "", clean.strip(), flags=re.MULTILINE).strip()
    m = re.search(r"\{[\s\S]+\}", clean)
    if not m:
        return None
    try:
        return json.loads(m.group())
    except json.JSONDecodeError as e:
        print(f"  [LLM] {skill['id']}: JSON decode failed: {e}", file=sys.stderr)
        return None


def write_skill(skill: dict, generated: dict) -> bool:
    skill_id = skill["id"]
    prompt_text = generated.get("prompt", "").strip()
    if not prompt_text:
        print(f"  [SKIP] {skill_id}: empty prompt from LLM", file=sys.stderr)
        return False

    valid_tools = [t for t in generated.get("tools", []) if t in KNOWN_TOOLS]

    skill_json = {
        "id":           skill_id,
        "name":         skill["name"],
        "icon":         generated.get("icon", "\U0001f9e0"),
        "description":  skill.get("description", ""),
        "tools":        valid_tools,
        "tags":         skill.get("tags", []),
        "examples":     generated.get("examples", []),
        "ubik_native":  True,
        "source_file":  "skills-seed.json (backfill)",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    skill_dir = USER_SKILLS_DIR / skill_id
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "skill.json").write_text(
        json.dumps(skill_json, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (skill_dir / "prompt.md").write_text(
        f"# {skill_json['name']}\n\n{prompt_text}\n", encoding="utf-8"
    )
    return True


def process_one(skill: dict, dry_run: bool, verbose: bool) -> tuple[str, str]:
    """Returns (id, status) where status in {'written','dry','llm_fail','write_fail'}."""
    sid = skill["id"]
    if dry_run:
        return sid, "dry"
    generated = call_engine(skill, verbose=verbose)
    if not generated:
        return sid, "llm_fail"
    if write_skill(skill, generated):
        return sid, "written"
    return sid, "write_fail"


def main() -> int:
    ap = argparse.ArgumentParser(description="Backfill autoskill prompts for UBIK Native skills")
    ap.add_argument("--dry-run", action="store_true", help="List ids without calling ENGINE")
    ap.add_argument("--limit", type=int, default=0, help="Process at most N ids")
    ap.add_argument("--ids", default="", help="Comma-separated ids to process")
    ap.add_argument("--burst", type=int, default=1, help="Concurrent ENGINE calls (default 1)")
    ap.add_argument("--verbose", action="store_true", help="Print ENGINE response previews")
    args = ap.parse_args()

    seed = json.loads(SKILLS_JSON.read_text(encoding="utf-8"))
    by_id = {s["id"]: s for s in seed["skills"] if s.get("domain") == DOMAIN}

    if args.ids:
        wanted = [i.strip() for i in args.ids.split(",") if i.strip()]
        targets = [by_id[i] for i in wanted if i in by_id]
        not_found = [i for i in wanted if i not in by_id]
        if not_found:
            print(f"[warn] not found in seed JSON: {not_found}", file=sys.stderr)
    else:
        targets = list(by_id.values())

    # Skip ids that already have a non-empty prompt.md
    final = []
    for s in targets:
        pm = USER_SKILLS_DIR / s["id"] / "prompt.md"
        if pm.exists() and pm.stat().st_size > 0:
            continue
        final.append(s)
    targets = final

    if args.limit > 0:
        targets = targets[: args.limit]

    print(
        f"[backfill] {len(targets)} target(s) | burst={args.burst}"
        f"{' | DRY-RUN' if args.dry_run else ''}",
        file=sys.stderr,
    )
    if not targets:
        return 0

    written = llm_fail = write_fail = 0
    t0 = time.time()

    if args.burst <= 1:
        for i, skill in enumerate(targets, 1):
            print(f"[{i}/{len(targets)}] {skill['id']}", file=sys.stderr)
            _, status = process_one(skill, args.dry_run, args.verbose)
            if status == "written" or status == "dry":
                written += 1
            elif status == "llm_fail":
                llm_fail += 1
            else:
                write_fail += 1
    else:
        with ThreadPoolExecutor(max_workers=args.burst) as pool:
            futs = {pool.submit(process_one, s, args.dry_run, args.verbose): s for s in targets}
            done = 0
            for fut in as_completed(futs):
                done += 1
                sid, status = fut.result()
                marker = {"written": "OK", "dry": "DRY", "llm_fail": "LLM", "write_fail": "WR"}[status]
                print(f"[{done}/{len(targets)}] {marker} {sid}", file=sys.stderr)
                if status in ("written", "dry"):
                    written += 1
                elif status == "llm_fail":
                    llm_fail += 1
                else:
                    write_fail += 1

    elapsed = time.time() - t0
    print(
        f"[backfill] done in {elapsed:.1f}s - {written} ok, {llm_fail} llm_fail, {write_fail} write_fail",
        file=sys.stderr,
    )
    return 0 if (llm_fail + write_fail) == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
