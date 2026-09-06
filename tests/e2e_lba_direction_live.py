#!/usr/bin/env python3
"""E2E RÉEL — carte t_d34e744fe6 (câblage lba_direction_classifier_priorite/
responsables/canaux/envois_attente, plan_62b0cc3b/wave1).

Ce script invoque RÉELLEMENT `bin/lba` (subprocess, exécutable tel quel côté
seat fleet) contre un VRAI serveur FastAPI — pas un mock de _get/_post comme
tests/test_lba_cli.py. Le serveur monte UNIQUEMENT bacchus_direction_tools.
router + bacchus_cli_session.router (LBA-DESKTOP/plan, lus en LECTURE SEULE
depuis le worktree LBA-DESKTOP--wt-plan_72a-6da176c2-agent-9 — aucune
écriture dans ce repo depuis ce script), sur un port éphémère et des bases
SQLite TEMPORAIRES (jamais les bases réelles /home/damienldx/data/*.db ni
~/.lba-desktop/*) — donc AUCUN effet de bord sur le cockpit réel d'André
DIRIL, contrairement à un appel direct de lba_direction_classifier_priorite
contre le :8504 live (qui créerait une VRAIE proposition 'classification'
dans la queue réelle, cf bandeau bacchus_direction_tools.py::bacchus_
direction_classifier — best-effort, inconditionnel dès que /classifier est
appelé).

Nécessite le venv LBA-DESKTOP (fastapi/uvicorn/pyjwt/cryptography) :
    /home/damienldx/workspace/LBA-DESKTOP/plan/.venv/bin/python3 \\
        tests/e2e_lba_direction_live.py

N'est PAS exécuté par tests/test_lba_cli.py (aucune dépendance FastAPI dans
ce repo ubik-mcp) — script autonome, à lancer explicitement.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.realpath(__file__))
BIN_LBA = os.path.join(HERE, "..", "bin", "lba")
LBA_DESKTOP_PLAN = "/home/damienldx/workspace/LBA-DESKTOP--wt-plan_72a-6da176c2-agent-9/plan"

_TMPDIR = tempfile.mkdtemp(prefix="lba_direction_e2e_")
_ENVIRON_OVERRIDES = {
    "LBA_JWT_SECRET": "test-jwt-secret-e2e-non-prod",
    "LBA_FERNET_KEY": None,  # généré ci-dessous (Fernet.generate_key)
    "DIRECTION_PROPOSITIONS_DB_PATH": os.path.join(_TMPDIR, "direction_propositions.db"),
    "MISSION_REQUESTS_DB_PATH": os.path.join(_TMPDIR, "mission_requests.db"),
    "BACCHUS_DIRECTION_ENVOIS_DB_PATH": os.path.join(_TMPDIR, "envois_attente.db"),
    "LBA_USERS_DB": os.path.join(_TMPDIR, "users.db"),
    "LBA_CLI_SESSION_SECRET_PATH": os.path.join(_TMPDIR, "cli-session.secret"),
}

_TEST_AGENT_ID = "e2e-agent-direction-test"
_TEST_EMAIL = "e2e-direction-test@lba-boissons.fr"


def _fail(msg: str) -> None:
    print(f"FAIL: {msg}")
    sys.exit(1)


def _setup_env_and_paths():
    from cryptography.fernet import Fernet
    _ENVIRON_OVERRIDES["LBA_FERNET_KEY"] = Fernet.generate_key().decode()
    for k, v in _ENVIRON_OVERRIDES.items():
        os.environ[k] = v
    sys.path.insert(0, LBA_DESKTOP_PLAN)


def _build_app_and_seed_user():
    from fastapi import FastAPI
    import bacchus_direction_tools
    import bacchus_cli_session
    import direction_propositions_db
    import mission_requests_db
    import bacchus_direction_autonomie
    from auth import users as users_db

    # init_db() est normalement appelé au boot par plan_service.py — ce
    # script monte les routers seuls, donc il doit reproduire ce geste
    # explicitement (CREATE TABLE IF NOT EXISTS, idempotent) sur les bases
    # TEMPORAIRES ci-dessus, sinon /classifier échoue en silence (best-
    # effort) faute de table.
    direction_propositions_db.init_db()
    mission_requests_db.init_db()
    bacchus_direction_autonomie.init_db()

    # Seat de test — mapping en mémoire uniquement, jamais écrit dans
    # bacchus_terminal_ticket.py (lecture seule, cf bandeau module).
    bacchus_cli_session._SEAT_AGENT_ID_BY_EMAIL[_TEST_EMAIL] = _TEST_AGENT_ID

    # Le secret CLI-session est normalement généré paresseusement par le
    # SERVEUR au premier POST /api/bacchus/cli/session (cf _cli_session_
    # secret) — mais le CLIENT (bin/lba) doit le LIRE pour minter sa preuve
    # AVANT ce premier POST -> force la génération ici, côté harness (rôle
    # que jouerait le provisioning réel/premier démarrage serveur en prod).
    bacchus_cli_session._cli_session_secret()

    users_db.upsert_microsoft_user(
        _TEST_EMAIL, "E2E Direction Test", "e2e-ms-oid", "fake-access", "fake-refresh",
        expires_at=int(time.time()) + 3600,
    )
    users_db.set_user_role(_TEST_EMAIL, role="commercial", rep_code=None, is_active=True)

    app = FastAPI()
    app.include_router(bacchus_direction_tools.router)
    app.include_router(bacchus_cli_session.router)
    return app


def _run_server(app, port_holder):
    import uvicorn
    config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning")
    server = uvicorn.Server(config)

    # port=0 -> port éphémère choisi par l'OS ; on le récupère après bind
    # via server.servers[0].sockets[0] (API interne uvicorn, stable depuis
    # longtemps, cf pattern déjà employé pour des tests uvicorn in-process).
    async def _serve():
        config.load()
        server.lifespan = config.lifespan_class(config)
        await server.startup(sockets=None)
        # startup() sans socket explicite lie sur config.port -> il faut
        # passer par un socket créé nous-mêmes pour port=0 réel.

    import socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port_holder["port"] = sock.getsockname()[1]
    sock.close()
    config.port = port_holder["port"]

    def _run():
        server.run()

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return server, t


def _wait_for_server(base_url: str, timeout=10.0):
    deadline = time.time() + timeout
    last_err = None
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f"{base_url}/api/bacchus/direction/priorites", timeout=1)
            return
        except Exception as e:  # noqa: BLE001 — on veut juste réessayer
            last_err = e
            time.sleep(0.2)
    raise RuntimeError(f"serveur e2e jamais prêt : {last_err}")


def _lba(tool: str, args: dict, extra_env: dict | None = None) -> dict:
    env = {**os.environ, "UBIK_AGENT_ID": _TEST_AGENT_ID, **(extra_env or {})}
    proc = subprocess.run(
        [sys.executable, BIN_LBA, tool, "--args", json.dumps(args)],
        capture_output=True, text=True, env=env, timeout=15,
    )
    if proc.returncode != 0:
        raise AssertionError(f"{tool} a échoué (rc={proc.returncode}): stdout={proc.stdout!r} stderr={proc.stderr!r}")
    return json.loads(proc.stdout)


def main():
    _setup_env_and_paths()
    app = _build_app_and_seed_user()
    port_holder = {}
    server, thread = _run_server(app, port_holder)
    base_url = f"http://127.0.0.1:{port_holder['port']}"
    os.environ["LBA_PLAN_BASE"] = base_url
    _wait_for_server(base_url)

    results = {}
    try:
        # ── 1. lba_direction_responsables (LECTURE, pas d'auth) ────────────
        r = _lba("lba_direction_responsables", {})
        assert "responsables" in r and len(r["responsables"]) == 6, r
        assert {x["id"] for x in r["responsables"]} >= {"sav", "adv", "logistique"}, r
        results["responsables_sans_texte"] = "OK"

        r = _lba("lba_direction_responsables", {"texte": "retard livraison chauffeur en panne"})
        assert "suggestions" in r, r
        top = r["suggestions"][0]
        assert top["score"] > 0, r
        results["responsables_avec_texte"] = f"OK (top={top['id']}, score={top['score']})"

        # ── 2. lba_direction_canaux (LECTURE, pas d'auth) ──────────────────
        r = _lba("lba_direction_canaux", {"responsable_id": "sav", "priorite": "URGENT"})
        assert "disponibles" in r and "recommande" in r, r
        results["canaux_ok"] = f"OK (recommande={r['recommande']})"

        try:
            _lba("lba_direction_canaux", {"responsable_id": "id_inexistant_xyz"})
            _fail("canaux aurait dû renvoyer 400 pour un responsable_id inconnu")
        except AssertionError as e:
            assert "400" in str(e) or "HTTP 400" in str(e), str(e)
            results["canaux_400_responsable_inconnu"] = "OK"

        # ── 3. lba_direction_classifier_priorite (VALIDATION, pas d'auth) ──
        r = _lba("lba_direction_classifier_priorite", {
            "priorite": "URGENT",
            "sujet": "Client Boissons du Nord menace de résilier son contrat (3 retards de livraison)",
        })
        assert r["priorite"] == "URGENT" and r["persisted"] is False, r
        assert r["proposition_id"], "une proposition classification aurait dû être créée (best-effort)"
        results["classifier_sans_mission_id"] = f"OK (proposition_id={r['proposition_id']})"

        try:
            _lba("lba_direction_classifier_priorite", {"priorite": "URGENT", "sujet": "trop court"})
            _fail("classifier aurait dû rejeter un sujet < 40 caractères substantiels")
        except AssertionError as e:
            assert "400" in str(e), str(e)
            results["classifier_400_sujet_trop_court"] = "OK"

        try:
            _lba("lba_direction_classifier_priorite", {"priorite": "PAS_UNE_VRAIE_PRIORITE", "sujet": "x" * 45})
            _fail("classifier aurait dû rejeter une priorité hors des 5 valeurs canon")
        except AssertionError as e:
            assert "priorite doit" in str(e) or "400" in str(e), str(e)
            results["classifier_refuse_priorite_inventee"] = "OK"

        # ── 4. lba_direction_envois_attente (LECTURE, AUTH ticket-exchange) ─
        r = _lba("lba_direction_envois_attente", {})
        assert "envois" in r and r["envois"] == [], r  # aucun envoi ORANGE en attente pour ce user tout neuf
        results["envois_attente_ticket_exchange_ok"] = "OK (liste vide, user tout neuf)"

        # Sans seat mappé (agent_id inconnu) -> 403 attendu, pas un succès silencieux.
        try:
            _lba("lba_direction_envois_attente", {}, extra_env={"UBIK_AGENT_ID": "agent-id-jamais-mappe-xyz"})
            _fail("envois_attente aurait dû refuser un agent_id non rattaché à un seat business")
        except AssertionError as e:
            assert "403" in str(e), str(e)
            results["envois_attente_403_seat_inconnu"] = "OK"

    finally:
        server.should_exit = True
        thread.join(timeout=5)

    print("=== E2E RÉEL — lba_direction_classifier_priorite/responsables/canaux/envois_attente ===")
    for k, v in results.items():
        print(f"  {k}: {v}")
    _EXPECTED_CHECKS = 9
    if len(results) != _EXPECTED_CHECKS:
        _fail(f"{len(results)}/{_EXPECTED_CHECKS} vérifications passées seulement")
    print(f"\n{len(results)}/{_EXPECTED_CHECKS} vérifications passées — bases temporaires : {_TMPDIR}")


if __name__ == "__main__":
    main()
