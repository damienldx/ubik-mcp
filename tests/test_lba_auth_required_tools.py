#!/usr/bin/env python3
"""Verrou du whitelisting _AUTH_REQUIRED_TOOLS (bin/lba, mission #3
plan_9d722ce9, décision arb_050496c8b4 option B) — re-gate Bertillon
(verdict "changements demandés" : archi validée, zéro test automatisé).
Étendu mission #1 plan_91c9dfb4 (lba_mission_request, lba_todo_task_create,
même whitelist/pattern d'appel réutilisés, endpoints déjà live sur :8504).

Ce que ce fichier protège : `bin/lba` est un script extensionless (pas
`bin/lba.py`), chargé ici via importlib comme `tests/test_relay_no_response_
repro.py` charge déjà `bin/ubik` de la même façon — pas de dépendance pytest
dans ce repo (aucun .venv/pytest.ini ici), conventions asserts + sys.exit,
exécutable directement (`python3 tests/test_lba_auth_required_tools.py`).

3 garanties vérifiées :
  1. _AUTH_REQUIRED_TOOLS == EXACTEMENT les 12 tools Graph/Todo (10 mission #3
     + lba_mission_request/lba_todo_task_create mission #1 plan_91c9dfb4) —
     ni plus (un futur tool DATA classé par erreur paierait un
     ticket-exchange inutile), ni moins (un tool Graph/Todo oublié
     appellerait :8504 SANS Authorization: Bearer -> 401 en silence).
  2. Les 18 tools DATA de Caton (mission #2) ne sont JAMAIS dans cette
     whitelist — la garantie "zéro régression" du brief, verrouillée.
  3. _auth_headers() ne déclenche le ticket-exchange (_mint_cli_session_jwt)
     QUE pour un tool de la whitelist — un tool DATA n'y touche jamais, même
     indirectement (pas de lecture du secret, pas d'appel réseau).
"""
from __future__ import annotations

import os
import sys
import types

_HERE = os.path.dirname(os.path.realpath(__file__))
_BIN_LBA = os.path.join(_HERE, "..", "bin", "lba")


def _load_lba():
    """`bin/lba` est extensionless (pas `bin/lba.py`) — même mécanisme de
    chargement que test_relay_no_response_repro.py::load_patched_stdio_call
    pour bin/ubik (exec(compile(...)) dans un namespace dédié plutôt
    qu'importlib.util, qui échoue silencieusement sans extension reconnue)."""
    mod = types.ModuleType("bin_lba")
    mod.__file__ = os.path.realpath(_BIN_LBA)
    with open(_BIN_LBA) as f:
        exec(compile(f.read(), _BIN_LBA, "exec"), mod.__dict__)
    return mod


# Les 10 tools Graph/Todo de CETTE mission — copie figée volontaire (pas un
# import de la constante testée) : le test doit casser si _AUTH_REQUIRED_TOOLS
# dérive, pas suivre silencieusement une édition non voulue.
_EXPECTED_AUTH_REQUIRED = frozenset({
    "lba_mail_liste", "lba_mail_lire", "lba_mail_repondre",
    "lba_calendar_liste", "lba_calendar_creer",
    "lba_teams_conversations", "lba_teams_repondre",
    "lba_todo_lists", "lba_todo_tasks", "lba_todo_task_status",
    "lba_mission_request", "lba_todo_task_create",
})

# Les 18 tools DATA de Caton (mission #2, commit 19c38ce) — jamais dans
# _AUTH_REQUIRED_TOOLS, jamais un ticket-exchange déclenché pour eux.
_EXPECTED_DATA_TOOLS_NEVER_AUTH = frozenset({
    "lba_client_fiche", "lba_client_historique_visites",
    "lba_client_recouvrement_statut", "lba_client_simulateur_prix",
    "lba_client_extrait_compte", "lba_client_relance_preview",
    "lba_rentabilite_produits", "lba_rentabilite_clients", "lba_tdc_kpis",
    "lba_clients_sans_visites", "lba_produits_dormants", "lba_kpis_portefeuille",
    "lba_dso_client", "lba_agenda_representants", "lba_portefeuille_liste",
    "lba_recherche_client", "lba_analytics_explorer", "lba_rep_codes",
})


def test_auth_required_tools_matches_exactly_the_12_graph_todo_tools():
    lba = _load_lba()
    assert lba._AUTH_REQUIRED_TOOLS == _EXPECTED_AUTH_REQUIRED, (
        f"dérive détectée: {lba._AUTH_REQUIRED_TOOLS ^ _EXPECTED_AUTH_REQUIRED}"
    )


def test_all_18_data_tools_are_excluded_from_auth_required():
    lba = _load_lba()
    overlap = lba._AUTH_REQUIRED_TOOLS & _EXPECTED_DATA_TOOLS_NEVER_AUTH
    assert not overlap, f"tool(s) DATA classé(s) à tort auth-required: {overlap}"


def test_every_tool_name_is_registered_in_tools_list():
    """Les 2 ensembles ci-dessus doivent couvrir EXACTEMENT TOOLS — un tool
    ajouté plus tard sans mise à jour de ce test serait silencieusement
    non-couvert (ni confirmé DATA, ni confirmé Graph/Todo)."""
    lba = _load_lba()
    all_names = {t["name"] for t in lba.TOOLS}
    covered = _EXPECTED_AUTH_REQUIRED | _EXPECTED_DATA_TOOLS_NEVER_AUTH
    assert all_names == covered, f"non couvert par ce test de verrou: {all_names ^ covered}"


def test_auth_headers_skips_ticket_exchange_for_data_tool(monkeypatch):
    lba = _load_lba()

    def _boom(agent_id):
        raise AssertionError("_mint_cli_session_jwt ne doit JAMAIS être appelé pour un tool DATA")

    monkeypatch.setattr(lba, "_mint_cli_session_jwt", _boom)
    assert lba._auth_headers("lba_client_fiche", None) == {}


def test_auth_headers_triggers_ticket_exchange_for_graph_tool(monkeypatch):
    lba = _load_lba()
    calls = []

    def _fake_mint(agent_id):
        calls.append(agent_id)
        return "fake.jwt.token"

    monkeypatch.setattr(lba, "_mint_cli_session_jwt", _fake_mint)
    headers = lba._auth_headers("lba_mail_liste", "22fcf4a5-agent-1")
    assert headers == {"Authorization": "Bearer fake.jwt.token"}
    assert calls == ["22fcf4a5-agent-1"]


def test_resolve_agent_id_prefers_explicit_over_env(monkeypatch):
    lba = _load_lba()
    monkeypatch.setenv("UBIK_AGENT_ID", "from-env")
    assert lba._resolve_agent_id("from-cli") == "from-cli"


def test_resolve_agent_id_falls_back_to_env(monkeypatch):
    lba = _load_lba()
    monkeypatch.delenv("UBIK_AGENT_ID", raising=False)
    monkeypatch.setenv("RELAY_AGENT_ID", "from-relay-env")
    assert lba._resolve_agent_id(None) == "from-relay-env"


def test_resolve_agent_id_raises_when_nothing_available(monkeypatch):
    lba = _load_lba()
    monkeypatch.delenv("UBIK_AGENT_ID", raising=False)
    monkeypatch.delenv("RELAY_AGENT_ID", raising=False)
    try:
        lba._resolve_agent_id(None)
        raise AssertionError("devait lever LbaCliError")
    except lba.LbaCliError:
        pass


# ── Wiring des 2 nouveaux tools (mission #1 plan_91c9dfb4) — juste le
# câblage path/payload/headers, le HMAC ticket-exchange lui-même est déjà
# couvert par test_bacchus_cli_session.py (pas à refaire) ─────────────────

def test_lba_mission_request_posts_expected_path_and_payload(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_post(path, payload, headers=None):
        captured["path"] = path
        captured["payload"] = payload
        captured["headers"] = headers
        return "{}"

    monkeypatch.setattr(lba, "_post", _fake_post)
    lba._exec("lba_mission_request", {
        "destinataire_email": "collegue@lba.fr", "titre": "Relancer client X",
        "description": "voir extrait de compte", "importance": "high"}, "22fcf4a5-agent-1")

    assert captured["path"] == "/api/me/missions/request"
    assert captured["payload"] == {
        "destinataire_email": "collegue@lba.fr", "titre": "Relancer client X",
        "description": "voir extrait de compte", "importance": "high"}
    assert captured["headers"] == {"Authorization": "Bearer fake.jwt.token"}


def test_lba_mission_request_requires_destinataire_email_and_titre(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    try:
        lba._exec("lba_mission_request", {"titre": "sans destinataire"}, "22fcf4a5-agent-1")
        raise AssertionError("devait lever LbaCliError (destinataire_email manquant)")
    except lba.LbaCliError:
        pass


def test_lba_todo_task_create_posts_expected_path_and_payload(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_post(path, payload, headers=None):
        captured["path"] = path
        captured["payload"] = payload
        captured["headers"] = headers
        return "{}"

    monkeypatch.setattr(lba, "_post", _fake_post)
    lba._exec("lba_todo_task_create", {
        "list_id": "AAMk-list-1", "title": "Rappeler client Y",
        "importance": "normal", "dueDateTime": "2026-07-25T09:00:00Z",
        "timeZone": "UTC", "body": "note libre"}, "22fcf4a5-agent-1")

    assert captured["path"] == "/api/me/todo/lists/AAMk-list-1/tasks"
    assert captured["payload"] == {
        "title": "Rappeler client Y", "importance": "normal",
        "dueDateTime": "2026-07-25T09:00:00Z", "timeZone": "UTC", "body": "note libre"}
    assert captured["headers"] == {"Authorization": "Bearer fake.jwt.token"}


def test_lba_todo_task_create_requires_list_id_and_title(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    try:
        lba._exec("lba_todo_task_create", {"title": "sans list_id"}, "22fcf4a5-agent-1")
        raise AssertionError("devait lever LbaCliError (list_id manquant)")
    except lba.LbaCliError:
        pass


# ── Runner sans pytest (convention du repo — cf test_relay_no_response_repro.py) ──

def _run_without_pytest() -> int:
    """Exécute les tests `def test_*` de ce module directement, avec un
    monkeypatch minimal maison (env + attribut), pour fonctionner même sans
    pytest installé (aucun .venv/pytest.ini dans ce repo aujourd'hui)."""
    import types

    class _MiniMonkeypatch:
        def __init__(self):
            self._env_restore = {}
            self._attr_restore = []

        def setenv(self, key, value):
            self._env_restore.setdefault(key, os.environ.get(key))
            os.environ[key] = value

        def delenv(self, key, raising=True):
            self._env_restore.setdefault(key, os.environ.get(key))
            os.environ.pop(key, None)

        def setattr(self, obj, name, value):
            self._attr_restore.append((obj, name, getattr(obj, name)))
            setattr(obj, name, value)

        def undo(self):
            for key, val in self._env_restore.items():
                if val is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = val
            for obj, name, val in reversed(self._attr_restore):
                setattr(obj, name, val)

    failures = []
    tests = [(k, v) for k, v in globals().items() if k.startswith("test_") and callable(v)]
    for name, fn in tests:
        mp = _MiniMonkeypatch()
        try:
            if "monkeypatch" in fn.__code__.co_varnames[: fn.__code__.co_argcount]:
                fn(mp)
            else:
                fn()
            print(f"PASS {name}")
        except Exception as e:
            failures.append((name, e))
            print(f"FAIL {name}: {e}")
        finally:
            mp.undo()

    print(f"\n{len(tests) - len(failures)}/{len(tests)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(_run_without_pytest())
