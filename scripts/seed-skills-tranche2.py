#!/usr/bin/env python3
"""seed-skills-tranche2.py — import a curated slice of UBIK-DESKTOP skills
into the local ubik-mcp skills store consumed by `src/servers/skills.ts`.

Source : ~/.ubik-desktop/data.db (table `skills`, ~23k rows).
Target : ~/.ubik-mcp/skills.db   (table `context`, key/content schema).

This script handles "tranche 2" — the slice of domains where
``hash(domain_name) mod 4 == 1``. The other three slices are seeded by
sibling scripts. Within the slice, we import only domains relevant to a
fleet agent (Claude Code working on code / infra / API / data) using a
keyword classifier:

  Positive cues (inclusion) : docker, kubernetes, container, auth, oauth,
    jwt, graphql, rest, api, observab, monitor, devops, ci/cd, iac,
    terraform, cloud, aws, gcp, azure, big data, pipeline, data engineer,
    secure cod, security, code review, debug, test, sql, nosql, cache.
  Negative cues (exclusion) : mobile, react native, flutter, swift,
    android, kotlin, ios, capacitor, blockchain, crypto, nft, token,
    game, unity, jeux, gaming, marketing, recommandation, recommender.

Each imported skill is written under the key
``skill/<sanitized-domain>/<skill-id>`` with a JSON payload
``{name, domain, description, system_prompt, tools, tags}``.

Usage:
    python3 scripts/seed-skills-tranche2.py [--source PATH] [--target PATH] [--dry-run]

Defaults respect the project layout: source ~/.ubik-desktop/data.db,
target ~/.ubik-mcp/skills.db. Pass --dry-run to print the count of
skills that would be inserted without writing anything.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

DEFAULT_SOURCE = Path.home() / ".ubik-desktop" / "data.db"
DEFAULT_TARGET = Path.home() / ".ubik-mcp"   / "skills.db"

TRANCHE_INDEX = 1  # 0-based; this is "tranche 2"
TRANCHE_TOTAL = 4

# Lower-cased substrings that mark a domain as relevant to fleet agents.
POSITIVE_KEYWORDS: tuple[str, ...] = (
    "docker", "kubernetes", "k8s", "container", "containeris", "orchestr",
    "auth", "oauth", "jwt", "saml", "session", "rbac", "iam", "permission",
    "graphql", "rest", "api ", "api-", "api(", "openapi", "swagger", "grpc", "rpc",
    "observab", "monitor", "trace", "telemetr", "log", "metric", "alert",
    "devops", "ci/cd", "ci-cd", "pipeline", "build", "release", "deploy",
    "iac", "terraform", "ansible", "pulumi", "infrastructure as code",
    "cloud", "aws", "gcp", "azure", "rds", "s3", "lambda", "fargate",
    "serverless",
    "big data", "data pipeline", "etl", "data engineer", "stream", "kafka",
    "data lake", "data mesh", "data warehouse", "snowflake", "bigquery",
    "secure cod", "security", "vulnerability", "penetration", "audit",
    "code review", "code quality", "refactor", "lint", "static analys",
    "debug", "profil", "performance", "scalability", "load",
    "sql", "nosql", "postgres", "mysql", "mongo", "redis", "elastic",
    "cache", "queue", "message broker", "event sourc",
    "feature flag", "config", "secret",
    "anomal", "drift", "decalage", "décalage", "ml ops", "mlops", "deploy", "model serving",
    "documentation", "spec", "openapi", "schema",
)

# Lower-cased substrings that exclude a domain.
NEGATIVE_KEYWORDS: tuple[str, ...] = (
    "mobile", "react native", "flutter", "ios", "android", "swift",
    "kotlin", "capacitor", "xamarin",
    "blockchain", "crypto", "nft", "staking", "token", "wallet", "defi",
    "smart contract", "ethereum", "solidity",
    "game", "unity", "unreal", "jeux", "gaming",
    "marketing", "ads", "publicit", "social media", "seo",
    "recommander", "recommandation", "recommender",
    "academic", "academique", "publication",
)

# ---------------------------------------------------------------------------


def _slug(s: str) -> str:
    s = s.strip().lower()
    s = re.sub(r"[^a-z0-9\-_/]+", "-", s)
    s = re.sub(r"-{2,}", "-", s).strip("-")
    return s or "x"


def _domain_in_tranche(domain: str) -> bool:
    """Stable bucket assignment: hash(domain) mod TRANCHE_TOTAL == TRANCHE_INDEX."""
    h = hashlib.md5(domain.encode("utf-8")).digest()
    return h[0] % TRANCHE_TOTAL == TRANCHE_INDEX


def _is_relevant(domain: str) -> bool:
    """Keyword classifier — domain is relevant for fleet agents."""
    text = domain.lower()
    if any(k in text for k in NEGATIVE_KEYWORDS):
        return False
    return any(k in text for k in POSITIVE_KEYWORDS)


def _ensure_target_schema(target: Path) -> sqlite3.Connection:
    target.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(target)
    db.execute("PRAGMA journal_mode = WAL")
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
    return db


def _coerce_json(raw: object) -> object:
    """Best-effort JSON decode; returns the original if it isn't JSON."""
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", errors="replace")
    if isinstance(raw, str):
        s = raw.strip()
        if s.startswith(("{", "[")):
            try:
                return json.loads(s)
            except Exception:
                return raw
        return raw
    return raw


def _build_payload(row: sqlite3.Row) -> dict:
    return {
        "name":         row["name"],
        "domain":       row["domain"],
        "description":  row["description"],
        "system_prompt": row["system_prompt"] if "system_prompt" in row.keys() else None,
        "tools":        _coerce_json(row["tools"])    if "tools"    in row.keys() else None,
        "tags":         _coerce_json(row["tags"])     if "tags"     in row.keys() else None,
        "examples":     _coerce_json(row["examples"]) if "examples" in row.keys() else None,
    }


def _row_columns(src: sqlite3.Connection) -> set[str]:
    cols = {r[1] for r in src.execute("PRAGMA table_info(skills)")}
    return cols


def _build_select(columns: set[str]) -> str:
    wanted = ["id", "name", "domain", "description", "system_prompt", "tools", "tags", "examples"]
    select = [c for c in wanted if c in columns]
    if not select:
        raise SystemExit("source skills table has none of the expected columns")
    return f"SELECT {', '.join(select)} FROM skills WHERE domain IS NOT NULL"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source",  type=Path, default=DEFAULT_SOURCE,
                        help=f"Source SQLite (default {DEFAULT_SOURCE}).")
    parser.add_argument("--target",  type=Path, default=DEFAULT_TARGET,
                        help=f"Target SQLite (default {DEFAULT_TARGET}).")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print counts without writing the target.")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Print one line per imported skill.")
    args = parser.parse_args(argv)

    if not args.source.is_file():
        print(f"[seed-tranche2] source not found: {args.source}", file=sys.stderr)
        return 1

    src = sqlite3.connect(args.source)
    src.row_factory = sqlite3.Row
    columns = _row_columns(src)
    select = _build_select(columns)

    domains_in_tranche  = 0
    domains_relevant    = 0
    skills_in_relevant  = 0
    skills_imported     = 0
    rejected_domains: list[tuple[str, str]] = []  # (domain, reason)
    sample_kept:    list[tuple[str, str]] = []  # (domain, name)

    rows = list(src.execute(select))
    by_domain: dict[str, list[sqlite3.Row]] = {}
    for r in rows:
        by_domain.setdefault(r["domain"], []).append(r)

    target_db: sqlite3.Connection | None = None
    if not args.dry_run:
        target_db = _ensure_target_schema(args.target)

    from datetime import datetime, timezone
    now_iso = datetime.now(timezone.utc).isoformat()

    for domain, items in sorted(by_domain.items()):
        if not _domain_in_tranche(domain):
            continue
        domains_in_tranche += 1
        if not _is_relevant(domain):
            rejected_domains.append((domain, "keyword classifier"))
            continue
        domains_relevant += 1
        skills_in_relevant += len(items)

        domain_slug = _slug(domain)
        for row in items:
            payload = _build_payload(row)
            key     = f"skill/{domain_slug}/{row['id']}"
            content = json.dumps(payload, ensure_ascii=False)

            if args.verbose:
                print(f"  + {key} :: {payload.get('name')}")
            if len(sample_kept) < 8:
                sample_kept.append((domain, payload.get("name") or "?"))

            if target_db is not None:
                target_db.execute(
                    """
                    INSERT INTO context (key, content, created_at, updated_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET
                      content    = excluded.content,
                      updated_at = excluded.updated_at
                    """,
                    (key, content, now_iso, now_iso),
                )
            skills_imported += 1

    if target_db is not None:
        target_db.commit()
        target_db.close()
    src.close()

    print("─── seed-skills-tranche2 ───────────────────────────────────")
    print(f"  source           : {args.source}")
    print(f"  target           : {args.target} ({'dry-run' if args.dry_run else 'wrote'})")
    print(f"  tranche          : {TRANCHE_INDEX + 1}/{TRANCHE_TOTAL} (hash mod {TRANCHE_TOTAL})")
    print(f"  domains in slice : {domains_in_tranche}")
    print(f"  domains kept     : {domains_relevant}")
    print(f"  domains skipped  : {len(rejected_domains)} (sample: {[d for d, _ in rejected_domains[:5]]})")
    print(f"  skills considered: {skills_in_relevant}")
    print(f"  skills imported  : {skills_imported}")
    if sample_kept:
        print(f"  sample kept      :")
        for d, n in sample_kept:
            print(f"    - [{d}] {n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
