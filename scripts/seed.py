#!/usr/bin/env python3
"""
Seed the ubik-mcp skill library from bundled data files.

Usage:
    python3 scripts/seed.py                  # seed skills + index agents (curated only)
    python3 scripts/seed.py --dry-run        # preview without writing
    python3 scripts/seed.py --skills-only    # skills only
    python3 scripts/seed.py --agents-only    # agents index only (curated only)
    python3 scripts/seed.py --purge-dormant  # delete non-registry agent/* rows from DB

Output: ~/.ubik-mcp/skills.db (same DB used by skills.ts at runtime)

Étape 5 (2026-06-27): agents filtrés par registry.yaml (liste blanche ~9 personas).
Tout agent hors registre = ignoré au seed + supprimable via --purge-dormant.
"""
import argparse
import json
import sqlite3
import sys
from pathlib import Path

REPO_ROOT    = Path(__file__).parent.parent
SKILLS_JSON  = REPO_ROOT / "data" / "skills-seed.json"
AGENTS_DIR   = REPO_ROOT / "data" / "agents"
DB_PATH      = Path.home() / ".ubik-mcp" / "skills.db"
REGISTRY_PATH = Path.home() / ".ubik-memory" / "autopipes" / "library" / "registry.yaml"


def load_registry_persona_ids() -> set[str]:
    """Load curated persona IDs from library/registry.yaml. Returns empty set on error."""
    try:
        import yaml
        if not REGISTRY_PATH.exists():
            print(f"[seed] WARN: registry.yaml not found at {REGISTRY_PATH}", file=sys.stderr)
            return set()
        with open(REGISTRY_PATH) as f:
            reg = yaml.safe_load(f)
        ids = {p["id"] for p in (reg.get("personas") or []) if p.get("id")}
        print(f"[seed] registry loaded — {len(ids)} curated persona IDs", file=sys.stderr)
        return ids
    except Exception as e:
        print(f"[seed] WARN: registry load failed: {e}", file=sys.stderr)
        return set()


def get_db(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(db_path)
    db.execute("""
        CREATE TABLE IF NOT EXISTS context (
            key        TEXT PRIMARY KEY,
            content    TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)
    db.commit()
    return db


def seed_skills(db: sqlite3.Connection, dry_run: bool) -> tuple[int, int]:
    if not SKILLS_JSON.exists():
        print(f"[seed] skills-seed.json not found at {SKILLS_JSON}", file=sys.stderr)
        return 0, 0

    data   = json.loads(SKILLS_JSON.read_text(encoding="utf-8"))
    skills = data.get("skills", [])
    now    = "2026-01-01T00:00:00Z"

    inserted = updated = 0
    for s in skills:
        key     = f"skill/{s['domain']}/{s['id']}"
        content = json.dumps({
            "name":          s["name"],
            "domain":        s["domain"],
            "description":   s.get("description", ""),
            "system_prompt": s.get("system_prompt", ""),
            "tools":         s.get("tools", []),
            "tags":          s.get("tags", []),
        }, ensure_ascii=False)

        if dry_run:
            inserted += 1
            continue

        existing = db.execute("SELECT key FROM context WHERE key = ?", (key,)).fetchone()
        if existing:
            db.execute("UPDATE context SET content = ?, updated_at = ? WHERE key = ?",
                       (content, now, key))
            updated += 1
        else:
            db.execute(
                "INSERT INTO context (key, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (key, content, now, now),
            )
            inserted += 1

    if not dry_run:
        db.commit()
    return inserted, updated


def seed_agents(db: sqlite3.Connection, dry_run: bool) -> tuple[int, int]:
    if not AGENTS_DIR.exists():
        print(f"[seed] agents/ directory not found at {AGENTS_DIR}", file=sys.stderr)
        return 0, 0

    # Étape 5: only seed curated personas from the registry whitelist.
    curated_ids = load_registry_persona_ids()
    if not curated_ids:
        print("[seed] WARN: empty registry — skipping agent seed (safety guard)", file=sys.stderr)
        return 0, 0

    agent_files = [f for f in AGENTS_DIR.glob("*.md") if f.stem in curated_ids]
    skipped = sum(1 for f in AGENTS_DIR.glob("*.md") if f.stem not in curated_ids)
    print(f"[seed] agents dir: {len(list(AGENTS_DIR.glob('*.md')))} files total, "
          f"{len(agent_files)} curated, {skipped} skipped (not in registry)", file=sys.stderr)

    now = "2026-01-01T00:00:00Z"
    inserted = updated = 0

    for path in agent_files:
        agent_id = path.stem
        key      = f"agent/{agent_id}"
        content  = json.dumps({
            "id":      agent_id,
            "source":  "ubik-mcp/data/agents",
            "content": path.read_text(encoding="utf-8", errors="replace"),
        }, ensure_ascii=False)

        if dry_run:
            inserted += 1
            continue

        existing = db.execute("SELECT key FROM context WHERE key = ?", (key,)).fetchone()
        if existing:
            db.execute("UPDATE context SET content = ?, updated_at = ? WHERE key = ?",
                       (content, now, key))
            updated += 1
        else:
            db.execute(
                "INSERT INTO context (key, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (key, content, now, now),
            )
            inserted += 1

    if not dry_run:
        db.commit()
    return inserted, updated


def purge_dormant_agents(db: sqlite3.Connection, dry_run: bool) -> int:
    """Delete all agent/* rows from the DB that are NOT in the registry whitelist."""
    curated_ids = load_registry_persona_ids()
    if not curated_ids:
        print("[seed] WARN: empty registry — refusing purge (safety guard)", file=sys.stderr)
        return 0

    all_agent_rows = db.execute(
        "SELECT key FROM context WHERE key LIKE 'agent/%'"
    ).fetchall()

    to_delete = [
        row[0] for row in all_agent_rows
        if row[0].replace("agent/", "", 1) not in curated_ids
    ]

    print(f"[seed] purge: {len(all_agent_rows)} agent rows total, "
          f"{len(to_delete)} non-registry to delete, "
          f"{len(all_agent_rows) - len(to_delete)} curated kept", file=sys.stderr)

    if dry_run:
        return len(to_delete)

    for key in to_delete:
        db.execute("DELETE FROM context WHERE key = ?", (key,))
    # Also clear stale vectors for purged agents
    for key in to_delete:
        db.execute("DELETE FROM skill_vectors WHERE key = ?", (key,))
    db.commit()
    return len(to_delete)


def main():
    parser = argparse.ArgumentParser(description="Seed ubik-mcp skill library")
    parser.add_argument("--dry-run",       action="store_true", help="Preview without writing")
    parser.add_argument("--skills-only",   action="store_true")
    parser.add_argument("--agents-only",   action="store_true")
    parser.add_argument("--purge-dormant", action="store_true",
                        help="Delete non-registry agent/* rows from DB (étape 5 cutover)")
    parser.add_argument("--db",            default=str(DB_PATH), help=f"DB path (default: {DB_PATH})")
    args = parser.parse_args()

    db_path     = Path(args.db)
    do_skills   = not args.agents_only and not args.purge_dormant
    do_agents   = not args.skills_only and not args.purge_dormant

    print(f"[seed] DB: {db_path}{' (dry-run)' if args.dry_run else ''}")
    db = get_db(db_path)

    if args.purge_dormant:
        deleted = purge_dormant_agents(db, args.dry_run)
        print(f"[seed] purge-dormant — {deleted} non-registry agent rows {'(dry-run)' if args.dry_run else 'deleted'}")
    else:
        if do_skills:
            ins, upd = seed_skills(db, args.dry_run)
            print(f"[seed] skills  — {ins} inserted, {upd} updated  (total: {ins + upd})")

        if do_agents:
            ins, upd = seed_agents(db, args.dry_run)
            print(f"[seed] agents  — {ins} inserted, {upd} updated  (total: {ins + upd})")

    db.close()
    print("[seed] done")


if __name__ == "__main__":
    main()
