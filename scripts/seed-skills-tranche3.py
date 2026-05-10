#!/usr/bin/env python3
"""
seed-skills-tranche3.py — import tranche 3 skills from UBIK Desktop into ubik-mcp.

Reads ~/.ubik-desktop/data.db (table `skills`) and seeds the curated tranche
into ~/.ubik-mcp/skills.db (table `context`) using:
    key     = "skill/<domain-slug>/<skill-id>"
    content = JSON {name, domain, description, system_prompt, tools, tags}

Tranche 3 covers the ML/data/frontend/API/scalability persona families that
extend the fleet beyond the already-migrated UBIK Native + infra core.

Usage:
    python3 scripts/seed-skills-tranche3.py            # writes
    python3 scripts/seed-skills-tranche3.py --dry-run  # preview only
    python3 scripts/seed-skills-tranche3.py --src PATH --dst PATH  # override

Idempotent: INSERT OR REPLACE on the target key.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# 14 domaines validés en sondage — cohérents avec critère agent fleet
# (data/ML/frontend/API/scalability). Voir relay vote 61d7d817-agent-0.
TRANCHE3_DOMAINS = [
    "Apprentissage Profond (Deep Learning)",
    "Vision par Ordinateur",
    "Gestion d'État React (Redux)",
    "Prévisions Séries Temporelles ML",
    "Frameworks Frontend (Vue.js)",
    "API gRPC",
    "Architecture Pilotée par les Données",
    "Exploration de Données (Data Mining)",
    "Monitoring de Modèles ML",
    "API GraphQL Backend",
    "Interprétabilité des Modèles ML",
    "Optimisation Performance React",
    "Stratégies de Scalabilité",
    "Analyse Automatisation Outils ML",
]

DEFAULT_SRC = Path.home() / ".ubik-desktop" / "data.db"
DEFAULT_DST = Path.home() / ".ubik-mcp" / "skills.db"


def slugify(s: str) -> str:
    """Normalise a domain name to a kebab-case key segment."""
    s = s.strip().lower()
    s = re.sub(r"\([^)]*\)", "", s)        # drop parenthesised qualifiers
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s or "unknown"


def parse_json_field(raw: str | None) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


def open_dst(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(path))
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS context (
            key        TEXT PRIMARY KEY,
            content    TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    db.execute("PRAGMA journal_mode = WAL")
    return db


def fetch_skills(src: sqlite3.Connection, domains: list[str]) -> list[dict[str, Any]]:
    placeholders = ",".join("?" * len(domains))
    cur = src.execute(
        f"SELECT id, name, domain, description, tools, tags, metadata "
        f"FROM skills WHERE domain IN ({placeholders}) ORDER BY domain, id",
        domains,
    )
    rows: list[dict[str, Any]] = []
    for sid, name, domain, description, tools, tags, metadata in cur:
        meta = parse_json_field(metadata) or {}
        rows.append(
            {
                "id":            sid,
                "name":          name,
                "domain":        domain,
                "description":   description,
                "tools":         parse_json_field(tools) or [],
                "tags":          parse_json_field(tags) or [],
                "system_prompt": meta.get("system_prompt") or "",
                "icon":          meta.get("icon") or "",
            }
        )
    return rows


def build_payload(skill: dict[str, Any]) -> tuple[str, str]:
    domain_slug = slugify(skill["domain"] or "unknown")
    sid = skill["id"]
    key = f"skill/{domain_slug}/{sid}"
    content = json.dumps(
        {
            "id":            sid,
            "name":          skill["name"],
            "domain":        skill["domain"],
            "description":   skill["description"],
            "system_prompt": skill["system_prompt"],
            "tools":         skill["tools"],
            "tags":          skill["tags"],
        },
        ensure_ascii=False,
    )
    return key, content


def upsert(dst: sqlite3.Connection, key: str, content: str) -> str:
    now = datetime.now(timezone.utc).isoformat()
    existing = dst.execute("SELECT 1 FROM context WHERE key = ?", (key,)).fetchone()
    if existing:
        dst.execute(
            "UPDATE context SET content = ?, updated_at = ? WHERE key = ?",
            (content, now, key),
        )
        return "replaced"
    dst.execute(
        "INSERT INTO context (key, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
        (key, content, now, now),
    )
    return "inserted"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--src", type=Path, default=DEFAULT_SRC, help="UBIK Desktop SQLite path")
    ap.add_argument("--dst", type=Path, default=DEFAULT_DST, help="ubik-mcp skills.db path")
    ap.add_argument("--dry-run", action="store_true", help="Preview without writing")
    ap.add_argument("--limit", type=int, default=0, help="Stop after N skills (0 = no cap)")
    args = ap.parse_args()

    if not args.src.exists():
        print(f"[seed-skills-tranche3] source not found: {args.src}", file=sys.stderr)
        return 1

    src = sqlite3.connect(f"file:{args.src}?mode=ro", uri=True)
    skills = fetch_skills(src, TRANCHE3_DOMAINS)
    src.close()

    by_domain: dict[str, int] = {}
    for s in skills:
        by_domain[s["domain"]] = by_domain.get(s["domain"], 0) + 1

    print(f"[seed-skills-tranche3] tranche 3 — {len(skills)} skills across {len(by_domain)} domains")
    for d in sorted(by_domain, key=lambda k: -by_domain[k]):
        print(f"  {by_domain[d]:4}  {d}")

    if args.dry_run:
        print(f"\n[seed-skills-tranche3] dry-run — no writes")
        return 0

    dst = open_dst(args.dst)
    inserted = replaced = 0
    try:
        for i, s in enumerate(skills, 1):
            if args.limit and i > args.limit:
                break
            key, content = build_payload(s)
            action = upsert(dst, key, content)
            if action == "inserted":
                inserted += 1
            else:
                replaced += 1
        dst.commit()
    finally:
        dst.close()

    print(
        f"\n[seed-skills-tranche3] done — {inserted} inserted, {replaced} replaced "
        f"into {args.dst}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
