#!/usr/bin/env python3
"""
Seed the ubik-mcp skill library from bundled data files.

Usage:
    python3 scripts/seed.py                  # seed skills + index agents
    python3 scripts/seed.py --dry-run        # preview without writing
    python3 scripts/seed.py --skills-only    # skills only
    python3 scripts/seed.py --agents-only    # agents index only

Output: ~/.ubik-mcp/skills.db (same DB used by skills.ts at runtime)
"""
import argparse
import json
import sqlite3
import sys
from pathlib import Path

REPO_ROOT   = Path(__file__).parent.parent
SKILLS_JSON = REPO_ROOT / "data" / "skills-seed.json"
AGENTS_DIR  = REPO_ROOT / "data" / "agents"
DB_PATH     = Path.home() / ".ubik-mcp" / "skills.db"


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

    agent_files = list(AGENTS_DIR.glob("*.md"))
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


def main():
    parser = argparse.ArgumentParser(description="Seed ubik-mcp skill library")
    parser.add_argument("--dry-run",     action="store_true", help="Preview without writing")
    parser.add_argument("--skills-only", action="store_true")
    parser.add_argument("--agents-only", action="store_true")
    parser.add_argument("--db",          default=str(DB_PATH), help=f"DB path (default: {DB_PATH})")
    args = parser.parse_args()

    db_path     = Path(args.db)
    do_skills   = not args.agents_only
    do_agents   = not args.skills_only

    print(f"[seed] DB: {db_path}{' (dry-run)' if args.dry_run else ''}")
    db = get_db(db_path)

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
