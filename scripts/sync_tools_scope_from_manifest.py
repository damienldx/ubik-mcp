#!/usr/bin/env python3
"""
sync_tools_scope_from_manifest.py — keeps role-bundles/<role>/tools.scope in
sync with the mandat YAML that actually drives RBAC (tools_whitelist /
tools_blacklist), so tools.scope stops being a hand-maintained duplicate.

Problem this fixes: tools.scope [allow] is the source read by
generate_tools_table.py (boot reflex table), but the ACTUAL RBAC policy for a
mandat lives in autopipes/mandats/<mandat>.yaml (tools_whitelist/blacklist).
Two hand-edited files describing the same thing drift apart silently (this is
exactly what happened to lba-seat: tools.scope had 15 tools while the yaml had
grown to 50). This script makes the yaml the single source of truth and
regenerates tools.scope mechanically — nobody should hand-edit tools.scope's
[allow]/[block] sections for a role wired this way ever again.

Usage:
  python3 sync_tools_scope_from_manifest.py --role lba-seat \
      --manifest ~/.ubik-memory/autopipes/mandats/lba-seat.yaml [--scope-dir PATH] [--check]

  --check : exit 1 (no write) if tools.scope would change — for a pre-boot /
            pre-commit guard instead of a silent rewrite.

Wiring: a role opts in by dropping a `manifest_source` file (one line: the
absolute path to its mandat yaml) in role-bundles/<role>/. The boot hook
(ubik-context-tools-boot.sh) calls this script automatically when that file is
present, right before generate_tools_table.py — see D1 section of the hook.
"""
import argparse
import os
import re
import sys

# Chemin OPÉRATEUR ABSOLU — jamais ~/... : sur un slot fleet, $HOME pointe vers
# /home/damienldx/.fleet/<slot>/, distinct de l'opérateur (piège prod documenté,
# CLAUDE.md > prod-home-trap). ~/.ubik-memory y est symlinké aujourd'hui, mais un
# défaut explicite évite de dépendre de ce symlink pour un futur environnement.
DEFAULT_SCOPE_DIR = "/home/damienldx/.ubik-memory/role-bundles"

HEADER_TEMPLATE = """# tools.scope — AUTO-GÉNÉRÉ depuis {manifest} (tools_whitelist/tools_blacklist).
# NE PAS ÉDITER À LA MAIN — toute modif sera écrasée au prochain sync. Pour
# changer la politique d'outils de ce rôle, éditer le yaml source ci-dessus
# puis relancer : python3 scripts/sync_tools_scope_from_manifest.py --role {role}
# (ou laisser le hook de boot le faire automatiquement — cf manifest_source).
#
# Invocation réelle des tools listés : CLI `lba <tool> --args '{{...}}'`
# (`lba --list` / `lba <tool> --schema`) — PAS des tools MCP, PAS de HTTP
# direct (note historique périmée corrigée ici, 2026-07-30).

[servers]
# Aucun — endpoints appelés via le CLI sibling `lba`, pas de serveur MCP à monter.

[allow]
"""


def extract_block(lines: list[str], key: str) -> list[str]:
    """Parse a `key:\\n  - item\\n  - item ...` YAML block, tolerating
    interleaved comment lines and multi-line trailing comments."""
    items = []
    in_block = False
    for line in lines:
        if re.match(rf"^{re.escape(key)}:\s*$", line):
            in_block = True
            continue
        if in_block:
            if re.match(r"^\S", line):  # dedent = next top-level key, stop
                break
            m = re.match(r"^\s*-\s+(\S+)", line)
            if m:
                items.append(m.group(1))
    return items


def generate_scope_content(manifest_path: str, role: str) -> str:
    lines = open(manifest_path).read().splitlines()
    whitelist = extract_block(lines, "tools_whitelist")
    blacklist = extract_block(lines, "tools_blacklist")

    out = [HEADER_TEMPLATE.format(manifest=manifest_path, role=role)]
    out.extend(whitelist)
    if blacklist:
        out.append("\n[block]")
        out.append("# Explicitement exclus côté mandat (tools_blacklist du manifest) :")
        out.extend(blacklist)
    return "\n".join(out) + "\n"


AUTOBLOCK_BEGIN = "# === AUTO-SYNC BEGIN"
AUTOBLOCK_END = "# === AUTO-SYNC END ==="


def strip_existing_autoblock(content: str) -> str:
    """Remove a previously-appended auto-sync block (idempotent re-append),
    leaving every hand-curated line above/below it untouched."""
    lines = content.splitlines()
    out, in_block = [], False
    for line in lines:
        if line.startswith(AUTOBLOCK_BEGIN):
            in_block = True
            continue
        if line.strip() == AUTOBLOCK_END:
            in_block = False
            continue
        if not in_block:
            out.append(line)
    return "\n".join(out).rstrip("\n")


def generate_append_block(manifest_path: str, role: str) -> str:
    """APPEND-ONLY variant: a fenced, mechanically-owned [allow-synced] /
    [block-synced] section added at the end of an EXISTING hand-curated
    tools.scope, never overwriting [servers]/[builtin-tools]/hand [allow]/
    comments above it. generate_tools_table.py's parse_scope_allow reads the
    union of [allow] and [allow-synced], de-duplicated — so a tool already
    listed by hand (with its own inline rationale comment) is not duplicated."""
    lines = open(manifest_path).read().splitlines()
    whitelist = extract_block(lines, "tools_whitelist")
    blacklist = extract_block(lines, "tools_blacklist")

    block = [
        f"\n{AUTOBLOCK_BEGIN} (généré depuis {manifest_path} — NE PAS ÉDITER,",
        "# remplacé au prochain sync ; tout le contenu AU-DESSUS de ce marqueur",
        "# reste géré à la main et n'est JAMAIS touché par le sync) ===",
        "",
        "[allow-synced]",
    ]
    block.extend(whitelist)
    if blacklist:
        block.append("")
        block.append("[block-synced]")
        block.append("# Explicitement exclus côté mandat (tools_blacklist du manifest) :")
        block.extend(blacklist)
    block.append(AUTOBLOCK_END)
    return "\n".join(block) + "\n"


def audit_against_cli(manifest_path: str, cli_list_cmd: str) -> int:
    """Compare the yaml's tools_whitelist/blacklist against the live tool
    catalog (e.g. `lba --list`, any command emitting a JSON array of
    {"name": ...}). Reports CLI tools that are neither whitelisted nor
    blacklisted — i.e. shipped but never policy-decided. This is the gap the
    boot-time scope sync CANNOT close on its own: a brand new tool has no
    entry anywhere until a human adds it to tools_whitelist/tools_blacklist.
    Run this whenever bin/lba (or an equivalent CLI) gains a new tool."""
    import subprocess
    import json as _json

    lines = open(manifest_path).read().splitlines()
    whitelist = set(extract_block(lines, "tools_whitelist"))
    blacklist = set(extract_block(lines, "tools_blacklist"))

    try:
        out = subprocess.run(cli_list_cmd, shell=True, capture_output=True, text=True, timeout=30, check=True)
        live_tools = [t["name"] for t in _json.loads(out.stdout)]
    except Exception as e:
        print(f"audit failed to run '{cli_list_cmd}': {e}", file=sys.stderr)
        return 2

    unclassified = [t for t in live_tools if t not in whitelist and t not in blacklist]
    stale = [t for t in whitelist if t not in live_tools]

    if not unclassified and not stale:
        print(f"audit OK: {len(live_tools)} live tools, all classified in {manifest_path}")
        return 0

    if unclassified:
        print(f"UNCLASSIFIED ({len(unclassified)}) — shipped in CLI, no whitelist/blacklist decision yet:")
        for t in unclassified:
            print(f"  {t}")
    if stale:
        print(f"STALE ({len(stale)}) — whitelisted but no matching live tool (typo or removed):")
        for t in stale:
            print(f"  {t}")
    return 1


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--role", required=True)
    p.add_argument("--manifest", required=True, help="Path to the mandat yaml (tools_whitelist source)")
    p.add_argument("--scope-dir", default=DEFAULT_SCOPE_DIR)
    p.add_argument("--check", action="store_true", help="Exit 1 if tools.scope would change, don't write")
    p.add_argument("--audit-cli", metavar="CMD",
                    help="Shell command emitting a JSON array of {name} (e.g. 'lba --list') — "
                         "diffs it against tools_whitelist/blacklist to catch new/renamed CLI tools")
    p.add_argument("--mode", choices=["append", "full"], default="append",
                    help="append (default, SAFE): add/refresh a fenced [allow-synced] block at the "
                         "end, never touching hand-curated content ([servers]/[builtin-tools]/[allow] "
                         "comments). full (DESTRUCTIVE): overwrite the whole file — only use for a "
                         "role whose tools.scope has no hand-curated content worth preserving (verify "
                         "with a diff first).")
    args = p.parse_args()

    manifest_path = os.path.expanduser(args.manifest)
    if not os.path.exists(manifest_path):
        print(f"manifest not found: {manifest_path}", file=sys.stderr)
        sys.exit(2)

    if args.audit_cli:
        sys.exit(audit_against_cli(manifest_path, args.audit_cli))

    scope_path = os.path.join(args.scope_dir, args.role, "tools.scope")
    old_content = open(scope_path).read() if os.path.exists(scope_path) else ""

    if args.mode == "full":
        new_content = generate_scope_content(manifest_path, args.role)
    else:
        preserved = strip_existing_autoblock(old_content)
        appended = generate_append_block(manifest_path, args.role)
        new_content = (preserved + "\n" + appended) if preserved else appended.lstrip("\n")

    if new_content == old_content:
        if not args.check:
            print(f"tools.scope already in sync for role={args.role}")
        sys.exit(0)

    if args.check:
        print(f"DRIFT: tools.scope for role={args.role} is out of sync with {manifest_path}", file=sys.stderr)
        sys.exit(1)

    os.makedirs(os.path.dirname(scope_path), exist_ok=True)
    with open(scope_path, "w") as f:
        f.write(new_content)
    print(f"synced ({args.mode}): {scope_path} <- {manifest_path}")


if __name__ == "__main__":
    main()
