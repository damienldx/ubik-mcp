#!/usr/bin/env python3
"""Verrou du whitelisting _AUTH_REQUIRED_TOOLS (bin/lba, mission #3
plan_9d722ce9, décision arb_050496c8b4 option B) — re-gate Bertillon
(verdict "changements demandés" : archi validée, zéro test automatisé).
Étendu mission #1 plan_91c9dfb4 (lba_mission_request, lba_todo_task_create,
même whitelist/pattern d'appel réutilisés, endpoints déjà live sur :8504).
Étendu mission #1 plan_13812401 (lba_visite_creer, POST /api/me/evenements,
contrat CONTRACT_ajout_manuel_visite.md — même pattern d'appel, RBAC
anti-spoofing déjà géré côté backend, non réimplémenté côté CLI).
Étendu mission #1 plan CLI Bridge Bacchus/procedures (7 tools
lba_procedure_creer/mine/modifier/supprimer/soumettre/liste/themes,
/api/me/procedures/* lba_api.py L9703-9802 déjà live — PAS de wrapper pour
/queue ni /{id}/validate, réservés backoffice@lba-boissons.fr).
Étendu mission M9 plan_7f0d0cc7 (t_35cd69831b, sprint dette 2026-07-27) :
lba_todo_task_delete (DELETE /api/me/todo/tasks/{task_id}) et
lba_todo_task_due (PATCH /api/me/todo/tasks/{task_id}/due), parité CLI avec
le protocole [[TASK:...]] frontend (taskBridge.ts) qui était la SEULE voie
pour ces 2 opérations alors que les endpoints backend étaient déjà live.

Ce que ce fichier protège : `bin/lba` est un script extensionless (pas
`bin/lba.py`), chargé ici via importlib comme `tests/test_relay_no_response_
repro.py` charge déjà `bin/ubik` de la même façon — pas de dépendance pytest
dans ce repo (aucun .venv/pytest.ini ici), conventions asserts + sys.exit,
exécutable directement (`python3 tests/test_lba_auth_required_tools.py`).

Contrat vérifié (mis à jour 2026-10-22) : depuis 2026-09-25 (arb_982536ed4a) la session est
obligatoire sur TOUT /api/* ; _auth_headers() envoie le JWT de session du seat pour TOUT outil,
DATA compris. _AUTH_REQUIRED_TOOLS reste la liste historique mais n'est plus un filtre (les anciens
verrous « exactement 12 tools » et « un tool DATA ne touche jamais le ticket-exchange » sont retirés).
"""
from __future__ import annotations

import os

import pytest
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


@pytest.fixture(autouse=True)
def _isolated_jwt_cache(monkeypatch):
    """Le cache JWT (/tmp/lba-cli-jwt-<uid>, TTL 90 s) ne doit pas fuir entre tests ni entre lancements."""
    import uuid
    monkeypatch.setattr(os, "getuid", lambda: f"test-{uuid.uuid4().hex}")
    yield


def test_every_tool_gets_session_jwt(monkeypatch):
    """Contrat depuis 2026-09-25 (arb_982536ed4a, auth/session_guard.py) : session obligatoire sur
    TOUT /api/*. Un outil DATA reçoit donc le même Bearer qu'un outil Graph ; _AUTH_REQUIRED_TOOLS
    n'est plus un filtre."""
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    for tool in ("lba_client_fiche", "lba_mail_liste", "lba_duckdb_lire"):
        assert lba._auth_headers(tool, "22fcf4a5-agent-1") == {"Authorization": "Bearer fake.jwt.token"}, tool


def test_auth_required_tools_is_not_a_filter(monkeypatch):
    lba = _load_lba()
    minted = []
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: minted.append(agent_id) or "j")
    assert "lba_client_fiche" not in lba._AUTH_REQUIRED_TOOLS
    assert lba._auth_headers("lba_client_fiche", "a-1")["Authorization"] == "Bearer j" and minted == ["a-1"]


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


# ── Wiring de lba_todo_task_delete/lba_todo_task_due (mission M9,
# plan_7f0d0cc7, t_35cd69831b) — parité CLI avec [[TASK:...]] frontend.

def test_lba_todo_task_delete_deletes_expected_path_with_list_id(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_delete(path, headers=None):
        captured["path"] = path
        captured["headers"] = headers
        return "{}"

    monkeypatch.setattr(lba, "_delete", _fake_delete)
    lba._exec("lba_todo_task_delete", {
        "task_id": "AAMk-task-1", "list_id": "AAMk-list-1"}, "22fcf4a5-agent-1")
    assert captured["path"] == "/api/me/todo/tasks/AAMk-task-1?list_id=AAMk-list-1"
    assert captured["headers"] == {"Authorization": "Bearer fake.jwt.token"}


def test_lba_todo_task_delete_omits_query_string_when_list_id_absent(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_delete(path, headers=None):
        captured["path"] = path
        return "{}"

    monkeypatch.setattr(lba, "_delete", _fake_delete)
    lba._exec("lba_todo_task_delete", {"task_id": "AAMk-task-1"}, "22fcf4a5-agent-1")
    assert captured["path"] == "/api/me/todo/tasks/AAMk-task-1"


def test_lba_todo_task_delete_requires_task_id(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    try:
        lba._exec("lba_todo_task_delete", {}, "22fcf4a5-agent-1")
        raise AssertionError("devait lever LbaCliError (task_id manquant)")
    except lba.LbaCliError:
        pass


def test_lba_todo_task_due_patches_expected_path_and_payload(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_patch(path, payload, headers=None):
        captured["path"] = path
        captured["payload"] = payload
        captured["headers"] = headers
        return "{}"

    monkeypatch.setattr(lba, "_patch", _fake_patch)
    lba._exec("lba_todo_task_due", {
        "task_id": "AAMk-task-1", "dueDateTime": "2026-07-25T09:00:00Z",
        "timeZone": "UTC", "list_id": "AAMk-list-1"}, "22fcf4a5-agent-1")

    assert captured["path"] == "/api/me/todo/tasks/AAMk-task-1/due"
    assert captured["payload"] == {
        "dueDateTime": "2026-07-25T09:00:00Z", "timeZone": "UTC", "list_id": "AAMk-list-1"}
    assert captured["headers"] == {"Authorization": "Bearer fake.jwt.token"}


def test_lba_todo_task_due_can_clear_due_date(monkeypatch):
    """dueDateTime absent == None envoyé au backend, qui traite absence et
    null identiquement (payload.get("dueDateTime")) pour RETIRER l'échéance
    — même contrat que me_todo_task_due (lba_api.py L9415-9436), pas de
    filtrage des None côté CLI ici (contrairement à lba_visite_creer, dont
    les None écraseraient des défauts backend distincts)."""
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_patch(path, payload, headers=None):
        captured["payload"] = payload
        return "{}"

    monkeypatch.setattr(lba, "_patch", _fake_patch)
    lba._exec("lba_todo_task_due", {"task_id": "AAMk-task-1"}, "22fcf4a5-agent-1")
    assert captured["payload"] == {"dueDateTime": None, "timeZone": None, "list_id": None}


def test_lba_todo_task_due_requires_task_id(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    try:
        lba._exec("lba_todo_task_due", {"dueDateTime": "2026-07-25T09:00:00Z"}, "22fcf4a5-agent-1")
        raise AssertionError("devait lever LbaCliError (task_id manquant)")
    except lba.LbaCliError:
        pass


# ── Wiring de lba_visite_creer (mission #1 plan_13812401) ──────────────────
# POST /api/me/evenements (lba_api.py::me_create_evenement), contrat
# CONTRACT_ajout_manuel_visite.md. RBAC anti-spoofing idUtilisateur déjà géré
# côté backend (_resolve_rep_for_create) — pas à retester ici, seulement le
# câblage path/payload/headers + l'omission des champs optionnels absents.

def test_lba_visite_creer_posts_expected_path_and_payload(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_post(path, payload, headers=None):
        captured["path"] = path
        captured["payload"] = payload
        captured["headers"] = headers
        return "{}"

    monkeypatch.setattr(lba, "_post", _fake_post)
    lba._exec("lba_visite_creer", {
        "libelle": "RDV dégustation", "date": "2026-07-25T09:00:00Z",
        "idSocieteAffectation": 887, "observations": "P1: relance"}, "22fcf4a5-agent-1")

    assert captured["path"] == "/api/me/evenements"
    assert captured["payload"] == {
        "libelle": "RDV dégustation", "date": "2026-07-25T09:00:00Z",
        "idSocieteAffectation": 887, "observations": "P1: relance"}
    assert captured["headers"] == {"Authorization": "Bearer fake.jwt.token"}


def test_lba_visite_creer_omits_absent_optional_fields(monkeypatch):
    """Un champ optionnel absent (ex: type/sens/etat/idUtilisateur) ne doit
    PAS être envoyé en null — un null explicite écraserait les défauts
    backend ("Rendez-vous", "SORTANT", "Non traité", auto-injection JWT) au
    lieu de les laisser s'appliquer (EvenementCreate, prisma_service.py)."""
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_post(path, payload, headers=None):
        captured["payload"] = payload
        return "{}"

    monkeypatch.setattr(lba, "_post", _fake_post)
    lba._exec("lba_visite_creer", {
        "libelle": "RDV dégustation", "date": "2026-07-25T09:00:00Z"}, "22fcf4a5-agent-1")

    assert captured["payload"] == {"libelle": "RDV dégustation", "date": "2026-07-25T09:00:00Z"}
    for absent_key in ("type", "sens", "etat", "idUtilisateur", "idContact",
                       "idSocieteAffectation", "idRequete", "datedebut",
                       "datefin", "observations"):
        assert absent_key not in captured["payload"], f"{absent_key} ne devrait pas apparaître (null implicite)"


def test_lba_visite_creer_requires_libelle_and_date(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    try:
        lba._exec("lba_visite_creer", {"date": "2026-07-25T09:00:00Z"}, "22fcf4a5-agent-1")
        raise AssertionError("devait lever LbaCliError (libelle manquant)")
    except lba.LbaCliError:
        pass
    try:
        lba._exec("lba_visite_creer", {"libelle": "RDV"}, "22fcf4a5-agent-1")
        raise AssertionError("devait lever LbaCliError (date manquant)")
    except lba.LbaCliError:
        pass


def test_lba_visite_creer_passes_idutilisateur_override_when_present(monkeypatch):
    """RBAC anti-spoofing n'est PAS réimplémenté côté CLI (verrou dur du
    mandat) — le CLI transmet idUtilisateur tel quel, le 403/400 est géré
    par _resolve_rep_for_create côté backend (lba_api.py L6588-6602)."""
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_post(path, payload, headers=None):
        captured["payload"] = payload
        return "{}"

    monkeypatch.setattr(lba, "_post", _fake_post)
    lba._exec("lba_visite_creer", {
        "libelle": "RDV", "date": "2026-07-25T09:00:00Z", "idUtilisateur": 101}, "22fcf4a5-agent-1")
    assert captured["payload"]["idUtilisateur"] == 101


# ── Wiring des 7 tools Procedures (mission #1, plan CLI Bridge Bacchus/
# procedures) — câblage path/payload/headers ; /queue et /{id}/validate ne
# sont volontairement PAS wrappés (backoffice@lba-boissons.fr uniquement).

def test_lba_procedure_creer_posts_expected_path_and_payload(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_post(path, payload, headers=None):
        captured["path"] = path
        captured["payload"] = payload
        captured["headers"] = headers
        return "{}"

    monkeypatch.setattr(lba, "_post", _fake_post)
    lba._exec("lba_procedure_creer", {
        "titre": "Procédure X", "theme": "Litige clients", "contenu": "Étapes..."}, "22fcf4a5-agent-1")

    assert captured["path"] == "/api/me/procedures"
    assert captured["payload"] == {
        "titre": "Procédure X", "theme": "Litige clients", "contenu": "Étapes..."}
    assert captured["headers"] == {"Authorization": "Bearer fake.jwt.token"}


def test_lba_procedure_creer_requires_titre_theme_contenu(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    for missing_args in ({"theme": "Litige clients", "contenu": "x"},
                          {"titre": "x", "contenu": "x"},
                          {"titre": "x", "theme": "Litige clients"}):
        try:
            lba._exec("lba_procedure_creer", missing_args, "22fcf4a5-agent-1")
            raise AssertionError(f"devait lever LbaCliError pour {missing_args}")
        except lba.LbaCliError:
            pass


def test_lba_procedure_mine_gets_expected_path(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_get(path, params, headers=None):
        captured["path"] = path
        captured["headers"] = headers
        return "{}"

    monkeypatch.setattr(lba, "_get", _fake_get)
    lba._exec("lba_procedure_mine", {}, "22fcf4a5-agent-1")
    assert captured["path"] == "/api/me/procedures/mine"
    assert captured["headers"] == {"Authorization": "Bearer fake.jwt.token"}


def test_lba_procedure_modifier_patches_expected_path_and_omits_absent_fields(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_patch(path, payload, headers=None):
        captured["path"] = path
        captured["payload"] = payload
        return "{}"

    monkeypatch.setattr(lba, "_patch", _fake_patch)
    lba._exec("lba_procedure_modifier", {
        "procedure_id": "proc-1", "titre": "Nouveau titre"}, "22fcf4a5-agent-1")
    assert captured["path"] == "/api/me/procedures/proc-1"
    assert captured["payload"] == {"titre": "Nouveau titre"}
    assert "theme" not in captured["payload"]
    assert "contenu" not in captured["payload"]


def test_lba_procedure_modifier_requires_procedure_id(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    try:
        lba._exec("lba_procedure_modifier", {"titre": "sans id"}, "22fcf4a5-agent-1")
        raise AssertionError("devait lever LbaCliError (procedure_id manquant)")
    except lba.LbaCliError:
        pass


def test_lba_procedure_supprimer_deletes_expected_path(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_delete(path, headers=None):
        captured["path"] = path
        captured["headers"] = headers
        return "{}"

    monkeypatch.setattr(lba, "_delete", _fake_delete)
    lba._exec("lba_procedure_supprimer", {"procedure_id": "proc-1"}, "22fcf4a5-agent-1")
    assert captured["path"] == "/api/me/procedures/proc-1"
    assert captured["headers"] == {"Authorization": "Bearer fake.jwt.token"}


def test_lba_procedure_soumettre_posts_expected_path(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_post(path, payload, headers=None):
        captured["path"] = path
        captured["payload"] = payload
        return "{}"

    monkeypatch.setattr(lba, "_post", _fake_post)
    lba._exec("lba_procedure_soumettre", {"procedure_id": "proc-1"}, "22fcf4a5-agent-1")
    assert captured["path"] == "/api/me/procedures/proc-1/submit"
    assert captured["payload"] == {}


def test_lba_procedure_liste_gets_expected_path_with_theme(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_get(path, params, headers=None):
        captured["path"] = path
        captured["params"] = params
        return "{}"

    monkeypatch.setattr(lba, "_get", _fake_get)
    lba._exec("lba_procedure_liste", {"theme": "Tarification"}, "22fcf4a5-agent-1")
    assert captured["path"] == "/api/me/procedures"
    assert captured["params"] == {"theme": "Tarification"}


def test_lba_procedure_liste_omits_theme_when_absent(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_get(path, params, headers=None):
        captured["params"] = params
        return "{}"

    monkeypatch.setattr(lba, "_get", _fake_get)
    lba._exec("lba_procedure_liste", {}, "22fcf4a5-agent-1")
    assert captured["params"] == {"theme": None}


def test_lba_procedure_themes_gets_expected_path(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_get(path, params, headers=None):
        captured["path"] = path
        return "{}"

    monkeypatch.setattr(lba, "_get", _fake_get)
    lba._exec("lba_procedure_themes", {}, "22fcf4a5-agent-1")
    assert captured["path"] == "/api/me/procedures/themes"


# ── Panel "Mes Documents" — devis assistés Bacchus (mission plan_9a6dda04
# wave1, 2026-07-30) — backend /api/me/documents/* déjà live (m_e48fc4a1). ──

def test_lba_devis_composer_posts_expected_path_and_payload(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_post(path, payload, headers=None):
        captured["path"] = path
        captured["payload"] = payload
        return "{}"

    monkeypatch.setattr(lba, "_post", _fake_post)
    lba._exec("lba_devis_composer", {
        "code": "C123", "lignes": [{"code": "A1", "famille": "BIERES", "quantite": 10}],
        "clientNom": "Bar Test",
    }, "22fcf4a5-agent-1")
    assert captured["path"] == "/api/me/client/C123/devis/composer"
    assert captured["payload"]["lignes"] == [{"code": "A1", "famille": "BIERES", "quantite": 10}]
    assert captured["payload"]["clientNom"] == "Bar Test"
    assert "representant" not in captured["payload"]  # omis si absent


def test_lba_devis_creer_requires_titre_and_html(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    try:
        lba._exec("lba_devis_creer", {"html": "<html></html>"}, "22fcf4a5-agent-1")
        raise AssertionError("devait lever LbaCliError (titre manquant)")
    except lba.LbaCliError:
        pass


def test_lba_devis_creer_posts_client_code(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_post(path, payload, headers=None):
        captured["path"] = path
        captured["payload"] = payload
        return "{}"

    monkeypatch.setattr(lba, "_post", _fake_post)
    lba._exec("lba_devis_creer", {
        "titre": "Devis test", "html": "<html></html>", "client_code": "C123",
    }, "22fcf4a5-agent-1")
    assert captured["path"] == "/api/me/documents"
    assert captured["payload"]["client_code"] == "C123"


def test_lba_devis_liste_defaults_type_to_devis(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_get(path, params, headers=None):
        captured["path"] = path
        captured["params"] = params
        return "{}"

    monkeypatch.setattr(lba, "_get", _fake_get)
    lba._exec("lba_devis_liste", {}, "22fcf4a5-agent-1")
    assert captured["path"] == "/api/me/documents"
    assert captured["params"]["type"] == "devis"


def test_lba_devis_liste_empty_string_type_removes_filter(monkeypatch):
    """type='' explicite -> pas de filtre (tous types), pas 'devis' par défaut."""
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_get(path, params, headers=None):
        captured["params"] = params
        return "{}"

    monkeypatch.setattr(lba, "_get", _fake_get)
    lba._exec("lba_devis_liste", {"type": ""}, "22fcf4a5-agent-1")
    assert captured["params"]["type"] is None


def test_lba_devis_lire_gets_expected_path(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_get(path, params, headers=None):
        captured["path"] = path
        return "{}"

    monkeypatch.setattr(lba, "_get", _fake_get)
    lba._exec("lba_devis_lire", {"document_id": "doc-1"}, "22fcf4a5-agent-1")
    assert captured["path"] == "/api/me/documents/doc-1"


def test_lba_devis_modifier_requires_at_least_one_field(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    try:
        lba._exec("lba_devis_modifier", {"document_id": "doc-1"}, "22fcf4a5-agent-1")
        raise AssertionError("devait lever LbaCliError (aucun champ à modifier)")
    except lba.LbaCliError:
        pass


def test_lba_devis_modifier_transmits_explicit_null_dossier_id(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_patch(path, payload, headers=None):
        captured["path"] = path
        captured["payload"] = payload
        return "{}"

    monkeypatch.setattr(lba, "_patch", _fake_patch)
    lba._exec("lba_devis_modifier", {"document_id": "doc-1", "dossier_id": None}, "22fcf4a5-agent-1")
    assert captured["payload"] == {"dossier_id": None}


def test_lba_devis_supprimer_deletes_expected_path(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_delete(path, headers=None):
        captured["path"] = path
        return "{}"

    monkeypatch.setattr(lba, "_delete", _fake_delete)
    lba._exec("lba_devis_supprimer", {"document_id": "doc-1"}, "22fcf4a5-agent-1")
    assert captured["path"] == "/api/me/documents/doc-1"


def test_lba_devis_dossier_creer_defaults_type_to_devis(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_post(path, payload, headers=None):
        captured["path"] = path
        captured["payload"] = payload
        return "{}"

    monkeypatch.setattr(lba, "_post", _fake_post)
    lba._exec("lba_devis_dossier_creer", {"nom": "Mes VIP"}, "22fcf4a5-agent-1")
    assert captured["path"] == "/api/me/documents/dossiers"
    assert captured["payload"] == {"nom": "Mes VIP", "type": "devis"}


def test_lba_devis_dossier_liste_gets_expected_path(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_get(path, params, headers=None):
        captured["path"] = path
        return "{}"

    monkeypatch.setattr(lba, "_get", _fake_get)
    lba._exec("lba_devis_dossier_liste", {}, "22fcf4a5-agent-1")
    assert captured["path"] == "/api/me/documents/dossiers"


# ── lba_devis_envoyer — garde confirmed_by_user (point de sécurité critique) ──
# hard_lock lba_seat_JAMAIS levé UNIQUEMENT avec confirmation explicite
# systématique (Damien) — cf bandeau bin/lba::_CONFIRMATION_REQUIRED_TOOLS.

def test_lba_devis_envoyer_refuses_without_confirmed_by_user(monkeypatch):
    lba = _load_lba()

    def _boom_mint(agent_id):
        raise AssertionError("le ticket-exchange ne doit JAMAIS être tenté sans confirmation")

    def _boom_post(path, payload, headers=None):
        raise AssertionError("aucun POST ne doit être émis sans confirmation")

    monkeypatch.setattr(lba, "_mint_cli_session_jwt", _boom_mint)
    monkeypatch.setattr(lba, "_post", _boom_post)
    try:
        lba._exec("lba_devis_envoyer", {
            "document_id": "doc-1", "to_email": "x@y.fr", "message": "bonjour",
        }, "22fcf4a5-agent-1")
        raise AssertionError("devait lever LbaCliError (confirmed_by_user absent)")
    except lba.LbaCliError:
        pass


def test_lba_devis_envoyer_refuses_falsy_or_non_bool_confirmation(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt",
                         lambda agent_id: (_ for _ in ()).throw(AssertionError("jamais appelé")))
    for bad_value in (False, "true", 1, "yes", None):
        try:
            lba._exec("lba_devis_envoyer", {
                "document_id": "doc-1", "to_email": "x@y.fr", "message": "bonjour",
                "confirmed_by_user": bad_value,
            }, "22fcf4a5-agent-1")
            raise AssertionError(f"devait lever LbaCliError pour confirmed_by_user={bad_value!r}")
        except lba.LbaCliError:
            pass


def test_lba_devis_envoyer_proceeds_with_confirmed_by_user_true(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_post(path, payload, headers=None):
        captured["path"] = path
        captured["payload"] = payload
        captured["headers"] = headers
        return "{}"

    monkeypatch.setattr(lba, "_post", _fake_post)
    lba._exec("lba_devis_envoyer", {
        "document_id": "doc-1", "to_email": "x@y.fr", "message": "bonjour",
        "confirmed_by_user": True,
    }, "22fcf4a5-agent-1")
    assert captured["path"] == "/api/me/documents/doc-1/envoyer"
    assert captured["headers"] == {"Authorization": "Bearer fake.jwt.token"}
    # confirmed_by_user est une garde CLI locale — ne fait JAMAIS partie du
    # contrat backend, ne doit jamais fuiter dans le payload envoyé.
    assert "confirmed_by_user" not in captured["payload"]
    assert captured["payload"] == {"to_email": "x@y.fr", "message": "bonjour"}


# ── Wiring de lba_whatsapp_envoyer (carte t_710b1c78d3, plan_425ab05c,
# mission #2) — mirroir exact du wiring lba_mail_envoyer : juste le câblage
# path/payload/headers, la garde VERT/ORANGE/ROUGE elle-même est côté
# backend (bacchus_whatsapp_envoyer.py, mission #1 déjà testée là-bas) —
# pas à retester ici. AUCUN tool CLI pour /confirmer (exclusion volontaire
# délibérée, même choix que mail/teams : le LLM ne doit jamais pouvoir
# confirmer un envoi ORANGE lui-même, seul un clic front humain le peut) —
# vérifié ci-dessous par absence dans TOOLS.

def test_lba_whatsapp_envoyer_posts_expected_path_and_payload(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_post(path, payload, headers=None):
        captured["path"] = path
        captured["payload"] = payload
        captured["headers"] = headers
        return "{}"

    monkeypatch.setattr(lba, "_post", _fake_post)
    lba._exec("lba_whatsapp_envoyer", {
        "chatId": "33612345678@s.whatsapp.net", "message": "Bonjour, confirmation."}, "22fcf4a5-agent-1")

    assert captured["path"] == "/api/bacchus/whatsapp/envoyer"
    assert captured["payload"] == {
        "chatId": "33612345678@s.whatsapp.net", "message": "Bonjour, confirmation."}
    assert captured["headers"] == {"Authorization": "Bearer fake.jwt.token"}


def test_lba_whatsapp_envoyer_requires_chatid_and_message(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    try:
        lba._exec("lba_whatsapp_envoyer", {"message": "sans chatId"}, "22fcf4a5-agent-1")
        raise AssertionError("devait lever LbaCliError (chatId manquant)")
    except lba.LbaCliError:
        pass
    try:
        lba._exec("lba_whatsapp_envoyer", {"chatId": "33612345678@s.whatsapp.net"}, "22fcf4a5-agent-1")
        raise AssertionError("devait lever LbaCliError (message manquant)")
    except lba.LbaCliError:
        pass


def test_lba_whatsapp_envoyer_has_no_confirmer_counterpart_in_tools():
    """Verrou dur : contrairement à lba_mail_envoyer, aucun tool CLI
    'lba_whatsapp_envoyer_confirmer' (ni variante) ne doit exister — la
    confirmation d'un envoi ORANGE reste un clic front humain uniquement."""
    lba = _load_lba()
    all_names = {t["name"] for t in lba.TOOLS}
    assert not any("whatsapp" in n and "confirmer" in n for n in all_names)


# ── Wiring des 4 tools panneau CLIENT référentiels (mission #5, 2026-09-02,
# plan_1ef5a724) — GET/PATCH /api/bacchus/referentiel/*, wrapper mission #6.
# La validation "au moins un des deux champs requis" (secteur-tournee) est
# volontairement PAS réimplémentée côté CLI (même doctrine que le RBAC
# anti-spoofing de lba_visite_creer ci-dessus) — 400 côté backend.

def test_lba_referentiel_familles_client_gets_expected_path(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_get(path, params, headers=None):
        captured["path"] = path
        captured["params"] = params
        captured["headers"] = headers
        return "[]"

    monkeypatch.setattr(lba, "_get", _fake_get)
    lba._exec("lba_referentiel_familles_client", {}, "22fcf4a5-agent-1")
    assert captured["path"] == "/api/bacchus/referentiel/familles-client"
    assert captured["params"] == {}
    assert captured["headers"] == {"Authorization": "Bearer fake.jwt.token"}


def test_lba_referentiel_tarifs_gets_expected_path(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_get(path, params, headers=None):
        captured["path"] = path
        captured["headers"] = headers
        return "[]"

    monkeypatch.setattr(lba, "_get", _fake_get)
    lba._exec("lba_referentiel_tarifs", {}, "22fcf4a5-agent-1")
    assert captured["path"] == "/api/bacchus/referentiel/tarifs"
    assert captured["headers"] == {"Authorization": "Bearer fake.jwt.token"}


def test_lba_referentiel_famille_affecter_patches_expected_path_and_payload(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_patch(path, payload, headers=None):
        captured["path"] = path
        captured["payload"] = payload
        captured["headers"] = headers
        return "{}"

    monkeypatch.setattr(lba, "_patch", _fake_patch)
    lba._exec("lba_referentiel_famille_affecter", {
        "code_client": "2590", "id_famille": 14}, "22fcf4a5-agent-1")
    assert captured["path"] == "/api/bacchus/referentiel/famille/2590"
    assert captured["payload"] == {"id_famille": 14}
    assert captured["headers"] == {"Authorization": "Bearer fake.jwt.token"}


def test_lba_referentiel_famille_affecter_requires_code_client_and_id_famille(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    try:
        lba._exec("lba_referentiel_famille_affecter", {"id_famille": 14}, "22fcf4a5-agent-1")
        raise AssertionError("devait lever LbaCliError (code_client manquant)")
    except lba.LbaCliError:
        pass
    try:
        lba._exec("lba_referentiel_famille_affecter", {"code_client": "2590"}, "22fcf4a5-agent-1")
        raise AssertionError("devait lever LbaCliError (id_famille manquant)")
    except lba.LbaCliError:
        pass


def test_lba_referentiel_famille_affecter_encodes_code_client_in_path(monkeypatch):
    """Même garde-fou que _seg ailleurs (ex. e63bc22) — un code_client avec
    un '/' ne doit pas casser le path PATCH."""
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_patch(path, payload, headers=None):
        captured["path"] = path
        return "{}"

    monkeypatch.setattr(lba, "_patch", _fake_patch)
    lba._exec("lba_referentiel_famille_affecter", {
        "code_client": "A/B", "id_famille": 14}, "22fcf4a5-agent-1")
    assert captured["path"] == "/api/bacchus/referentiel/famille/A%2FB"


def test_lba_referentiel_secteur_tournee_affecter_patches_expected_path_and_payload(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_patch(path, payload, headers=None):
        captured["path"] = path
        captured["payload"] = payload
        captured["headers"] = headers
        return "{}"

    monkeypatch.setattr(lba, "_patch", _fake_patch)
    lba._exec("lba_referentiel_secteur_tournee_affecter", {
        "code_client": "2590", "id_secteur_commercial": 3, "id_tournee_fixe": 7}, "22fcf4a5-agent-1")
    assert captured["path"] == "/api/bacchus/referentiel/secteur-tournee/2590"
    assert captured["payload"] == {"id_secteur_commercial": 3, "id_tournee_fixe": 7}
    assert captured["headers"] == {"Authorization": "Bearer fake.jwt.token"}


def test_lba_referentiel_secteur_tournee_affecter_omits_absent_field(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    captured = {}

    def _fake_patch(path, payload, headers=None):
        captured["payload"] = payload
        return "{}"

    monkeypatch.setattr(lba, "_patch", _fake_patch)
    lba._exec("lba_referentiel_secteur_tournee_affecter", {
        "code_client": "2590", "id_secteur_commercial": 3}, "22fcf4a5-agent-1")
    assert captured["payload"] == {"id_secteur_commercial": 3, "id_tournee_fixe": None}


def test_lba_referentiel_secteur_tournee_affecter_requires_code_client(monkeypatch):
    lba = _load_lba()
    monkeypatch.setattr(lba, "_mint_cli_session_jwt", lambda agent_id: "fake.jwt.token")
    try:
        lba._exec("lba_referentiel_secteur_tournee_affecter", {"id_secteur_commercial": 3}, "22fcf4a5-agent-1")
        raise AssertionError("devait lever LbaCliError (code_client manquant)")
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
