#!/usr/bin/env python3
"""
generate_tools_table.py — D1 Étage Réflexe du Moteur de Tools.

Génère une table markdown situation→tool à partir du tools.scope d'un rôle.
Source unique : tools.scope [allow] section. Les situations viennent du catalog
data/tools-situations.json (curé, pas un fichier mort — compagnon de tools.scope).

Usage:
  python3 generate_tools_table.py --role worker [--scope-dir PATH] [--format md|header]
  python3 generate_tools_table.py --role lead --format header   # injection boot (compact)

Retourne une table | Situation | Réflexe | prête à être injectée dans le contexte.

Le hook ubik-context-tools-boot.sh appelle ce script avec --format header pour
obtenir le bloc complet (header + table + footer) à injecter au boot.
"""
import argparse
import json
import os
import re
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
SITUATIONS_CATALOG = os.path.join(REPO_ROOT, "data", "tools-situations.json")

# Default scope-dir — the canonical location of role-bundles
DEFAULT_SCOPE_DIR = os.path.expanduser("~/.ubik-memory/role-bundles")


def parse_scope_allow(scope_path: str) -> list[str]:
    """Parse [allow] AND [allow-synced] sections of a tools.scope file, unioned
    and de-duplicated (first occurrence wins for ordering). [allow] is the
    hand-curated section (may carry inline comments/rationale per tool);
    [allow-synced] is the auto-generated append maintained by
    sync_tools_scope_from_manifest.py from the role's mandat yaml — a role can
    have either, both, or neither. Keeping them as two sections (instead of
    merging on write) means the hand-curated section is NEVER touched by the
    sync script, only ever read here."""
    tools = []
    seen = set()
    in_allow_section = False
    try:
        with open(scope_path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("["):
                    in_allow_section = line in ("[allow]", "[allow-synced]")
                    continue
                if in_allow_section and line not in seen:
                    tools.append(line)
                    seen.add(line)
    except FileNotFoundError:
        pass
    return tools


def load_situations() -> dict:
    """Load the situations catalog."""
    try:
        with open(SITUATIONS_CATALOG) as f:
            data = json.load(f)
            return data.get("tools", {})
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def generate_table(role: str, scope_dir: str = DEFAULT_SCOPE_DIR) -> tuple[list[str], list[dict]]:
    """
    Returns (missing_tools, rows) where:
    - missing_tools = tool names in [allow] but not in the situations catalog
    - rows = list of {tool, situation, cli} dicts, ordered as in tools.scope
    """
    scope_path = os.path.join(scope_dir, role, "tools.scope")
    allowed = parse_scope_allow(scope_path)

    # Skip built-in tools (Bash, Read, Edit, Write, Grep, Glob, etc.)
    builtin = {"Bash", "Read", "Edit", "Write", "Grep", "Glob", "NotebookEdit",
               "WebFetch", "WebSearch", "ubik", "skills", "workspace", "janus"}
    allowed = [t for t in allowed if t not in builtin]

    situations = load_situations()
    rows = []
    missing = []

    for tool in allowed:
        if tool in situations:
            entry = situations[tool]
            rows.append({
                "tool": tool,
                "situation": entry["situation"],
                "cli": entry["cli"],
                "note": entry.get("note", ""),
            })
        else:
            missing.append(tool)
            # Include the tool even without a curated situation (degrade gracefully)
            rows.append({
                "tool": tool,
                "situation": f"[non catalogué] {tool}",
                "cli": f"ubik agent {tool}",
                "note": "situation manquante dans data/tools-situations.json",
            })

    return missing, rows


def render_markdown(role: str, rows: list[dict]) -> str:
    """Render a compact | Situation | Réflexe | markdown table."""
    if not rows:
        return f"_(aucun outil catalogué pour le rôle `{role}`)_\n"

    lines = [
        f"| Situation | Réflexe (`ubik <ns> <tool>`) |",
        "|---|---|",
    ]
    for r in rows:
        situation = r["situation"]
        cli = r["cli"].replace("|", "\\|")
        note = f" _{r['note']}_" if r.get("note") else ""
        lines.append(f"| {situation}{note} | `{cli}` |")

    return "\n".join(lines) + "\n"


def render_header_block(role: str, rows: list[dict], missing: list[str]) -> str:
    """Render the full injection block (header + table + footer) for boot hook."""
    table = render_markdown(role, rows)
    missing_note = ""
    if missing:
        missing_note = f"\n_({len(missing)} tools hors-catalog — ajouter dans data/tools-situations.json: {', '.join(missing[:5])}{'...' if len(missing)>5 else ''})_\n"

    return (
        "============================================================\n"
        f"TOOLS RÉFLEXES — rôle `{role}` (source: role-bundles/{role}/tools.scope)\n"
        "============================================================\n"
        "Table situation→tool pour les outils courants de ton rôle.\n"
        "Long-tail → `ubik workspace qubik_suggest --args '{\"query\":\"je veux faire X\"}'`\n\n"
        + table
        + missing_note
        + "============================================================\n"
    )


def main():
    parser = argparse.ArgumentParser(description="Generate situation→tool table from tools.scope")
    parser.add_argument("--role", required=True, help="Role bundle name (e.g. worker, lead, chef-atelier)")
    parser.add_argument("--scope-dir", default=DEFAULT_SCOPE_DIR, help="Path to role-bundles directory")
    parser.add_argument("--format", choices=["md", "header", "json"], default="header",
                        help="md=table only, header=boot injection block, json=raw rows")
    args = parser.parse_args()

    scope_path = os.path.join(args.scope_dir, args.role, "tools.scope")
    if not os.path.exists(scope_path):
        # Soft fail: if scope file missing, print nothing (hook stays clean)
        sys.exit(0)

    missing, rows = generate_table(args.role, args.scope_dir)

    if args.format == "json":
        print(json.dumps({"role": args.role, "rows": rows, "missing": missing}, ensure_ascii=False, indent=2))
    elif args.format == "md":
        print(render_markdown(args.role, rows))
    else:
        print(render_header_block(args.role, rows, missing))


if __name__ == "__main__":
    main()
