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
    "lba_mission_request", "lba_todo_task_create", "lba_todo_task_delete",
    "lba_todo_task_due", "lba_visite_creer",
    "lba_visites_liste", "lba_visite_modifier",
    "lba_procedure_creer", "lba_procedure_mine", "lba_procedure_modifier",
    "lba_procedure_supprimer", "lba_procedure_soumettre",
    "lba_procedure_liste", "lba_procedure_themes",
    "lba_reunion_template", "lba_reunion_creer", "lba_reunion_liste",
    "lba_reunion_lire", "lba_reunion_modifier", "lba_reunion_supprimer",
    "lba_reunion_dossier_creer", "lba_reunion_dossier_liste",
    # ^ 2 lignes ajoutées 2026-07-30 (drift pré-existant hors mission plan_9a6dda04,
    # trouvé en vérifiant l'état AVANT ma propre extension : ces 2 tools existent
    # bien dans bin/lba._AUTH_REQUIRED_TOOLS depuis les sous-dossiers REUNION
    # [2026-07-29] mais n'avaient jamais été ajoutés ici — 2 tests de ce fichier
    # étaient rouges avant toute modification de ma part, cf ledger de mission).
    # mission plan_9a6dda04 wave1 (2026-07-30) : panel "Mes Documents" / devis
    # assistés Bacchus — /api/me/documents/* exige Depends(current_user) réel,
    # même filtre strict auteur_email côté backend que les autres tools ici.
    "lba_devis_composer", "lba_devis_creer", "lba_devis_liste",
    "lba_devis_lire", "lba_devis_modifier", "lba_devis_supprimer",
    "lba_devis_dossier_creer", "lba_devis_dossier_liste", "lba_devis_envoyer",
    # carte t_710b1c78d3 (plan_425ab05c, mission #2) — gate d'envoi WhatsApp
    # sortant, mirroir exact lba_mail_envoyer/lba_devis_envoyer : POST
    # /api/bacchus/whatsapp/envoyer, Depends(current_user) réel côté backend
    # (bacchus_whatsapp_envoyer.py, mission #1 LBA-DESKTOP déjà livrée).
    "lba_whatsapp_envoyer",
    # Généralisation multi-seat Direction (2026-08-30, LEAD 1to1) — les 4
    # endpoints propositions/synthèse/connaissances scopés par current_user
    # (LBA-DESKTOP/plan/direction_propositions_api.py,
    # direction_connaissances_api.py) exigent le ticket-exchange pour que le
    # backend résolve QUI demande, même mécanisme que lba_mail_envoyer/
    # lba_calendar_creer ci-dessus.
    "lba_direction_propositions_lister", "lba_direction_synthese_lire",
    "lba_connaissances_rechercher", "lba_connaissances_ajouter",
    # Mission "muscler la base SQL" (2026-08-30, LEAD 1to1) — recherche dans
    # la base de connaissance unifiée FTS5 (LBA-DESKTOP/plan/
    # direction_knowledge_api.py), même mécanisme current_user.
    "lba_historique_rechercher",
    # Ajout 2026-08-30 (même session) — reconstitue un fil précis en ordre
    # chronologique (GET /api/direction/knowledge/fil), même mécanisme.
    "lba_historique_fil_lire",
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
    "lba_client_tarif", "lba_client_remises_negociees",
    # mission #4 plan_c5ebf394 (2026-08-04) : cablage CLI de
    # GET /api/bacchus/articles/liste (mission #1, aucun Depends(current_user)
    # côté backend, même posture que les autres tools DATA ci-dessus).
    "lba_articles_liste",
    # mission #2 plan_c5ebf394 (2026-08-04) : cablage CLI de
    # GET /api/bacchus/clients/filtre (aucun Depends(current_user) côté
    # backend, même posture que lba_articles_liste ci-dessus).
    "lba_clients_filtre",
    # plan_9a274922 (2026-08-17) : cablage CLI de GET /api/bacchus/tarifs/
    # audit-facturation (aucun Depends(current_user) côté backend, confirmé
    # par test structurel côté LBA-DESKTOP — même posture que le reste des
    # routes /simuler de bacchus_tarifs_tools.py).
    "lba_audit_facturation",
    # plan_d9a888da (2026-08-19, mission Phase 4) : cablage CLI des avoirs
    # PrismaSoft (aucun Depends(current_user) côté backend, whitelist gérée
    # par prisma-api/wrapper Bacchus eux-mêmes — même posture que
    # lba_achats_reception_simuler/_creer, DATA/écriture métier, pas un
    # tool Graph/Todo nécessitant le ticket-exchange de session).
    "lba_avoir_simuler", "lba_avoir_creer",
    # plan_a7c60f1c (2026-08-21, mission #4) : cablage CLI du flux Import BL
    # (aucun Depends(current_user) côté backend LBA-DESKTOP, whitelist/
    # confirm gérés par le wrapper Bacchus + prisma-api eux-mêmes — même
    # posture que lba_avoir_simuler/_creer ci-dessus, DATA/écriture métier,
    # pas un tool Graph/Todo).
    "lba_achats_bl_lignes_non_imputees", "lba_achats_bl_resoudre_reference",
    "lba_achats_bl_importer_lignes", "lba_achats_bl_tracer_resolution_forcee",
    # plan_eb472683 (2026-08-21, mission #4 follow-up Import BL) : cablage
    # CLI de modifier_entete_facture_fournisseur — meme posture que les 4
    # tools lba_achats_bl_* ci-dessus (whitelist/confirm geres cote
    # prisma-api + wrapper Bacchus, pas un tool Graph/Todo).
    "lba_achats_bl_modifier_entete",
    # plan_101221aa (2026-08-21, mission #3, volet 3) : cablage CLI de
    # lire_entete_facture_fournisseur (lecture pure, aucun gate ni cote
    # prisma-api ni cote wrapper Bacchus) — meme posture que les tools
    # lba_achats_bl_* ci-dessus, pas un tool Graph/Todo.
    "lba_achats_bl_lire_entete",
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
