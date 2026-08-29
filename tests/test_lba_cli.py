#!/usr/bin/env python3
"""Tests bin/lba — verrouille la construction d'URL (encodage des segments de
PATH) + --list/--schema. Gate Bertillon (2026-07-22, M2 plan_9d722ce9) :
- URL-encoding manquant sur code/tiers_id/famille (même classe que e63bc22)
- zéro test existant

bin/lba n'a pas d'extension .py -> chargé via importlib.util.spec_from_file_location
(même pattern que les autres tests de bin/ dans ce repo, cf tests/test_relay_no_response_repro.py
pour bin/ubik). _get est monkeypatché pour capturer (path, params) sans appel réseau réel.
"""
import importlib.util
import json
import os
import subprocess
import sys
import unittest
from importlib.machinery import SourceFileLoader

HERE = os.path.dirname(os.path.realpath(__file__))
BIN_LBA = os.path.join(HERE, "..", "bin", "lba")

# bin/lba n'a pas d'extension .py -> spec_from_file_location() seul ne
# détecte pas de loader (retourne None) ; on doit lui donner un SourceFileLoader
# explicite pour qu'il compile/exécute le fichier comme du Python.
_loader = SourceFileLoader("lba_cli", BIN_LBA)
spec = importlib.util.spec_from_loader("lba_cli", _loader)
lba_cli = importlib.util.module_from_spec(spec)
_loader.exec_module(lba_cli)


class CapturedGet(Exception):
    """Utilisé pour court-circuiter _get et récupérer (path, params) sans HTTP."""

    def __init__(self, path, params):
        self.path = path
        self.params = params


class TestUrlEncoding(unittest.TestCase):
    def setUp(self):
        self._orig_get = lba_cli._get

        def fake_get(path, params):
            raise CapturedGet(path, params)

        lba_cli._get = fake_get

    def tearDown(self):
        lba_cli._get = self._orig_get

    def _captured_path(self, tool, args):
        with self.assertRaises(CapturedGet) as ctx:
            lba_cli._exec(tool, args)
        return ctx.exception.path

    def test_client_fiche_encodes_special_char_in_code(self):
        # code contenant '/' — doit être encodé (safe=""), pas casser le path.
        path = self._captured_path("lba_client_fiche", {
            "code": "AB/12", "date_from": "2026-01-01", "date_to": "2026-07-22"})
        self.assertEqual(path, "/api/bacchus/client/AB%2F12/fiche")

    def test_client_simulateur_prix_encodes_both_segments(self):
        path = self._captured_path("lba_client_simulateur_prix", {
            "code": "P 213", "famille": "VINS&SPIRITUEUX"})
        self.assertIn("P%20213", path)
        self.assertIn("VINS%26SPIRITUEUX", path)

    def test_client_extrait_compte_encodes_tiers_id(self):
        # tiers_id passe par _seg même si int côté schéma (str() défensif).
        path = self._captured_path("lba_client_extrait_compte", {"tiers_id": 2172})
        self.assertEqual(path, "/api/bacchus/client/tiers/2172/extrait-compte")

    def test_client_recouvrement_statut_plain_code_unchanged(self):
        # code sans caractère spécial : pas de sur-encodage inattendu.
        path = self._captured_path("lba_client_recouvrement_statut", {"code": "P213"})
        self.assertEqual(path, "/api/bacchus/client/P213/recouvrement-statut")


class CapturedPatch(Exception):
    """Utilisé pour court-circuiter _patch et récupérer (path, payload) sans HTTP."""

    def __init__(self, path, payload):
        self.path = path
        self.payload = payload


class TestVisiteModifierSource(unittest.TestCase):
    """source='cr_live' (2026-07-27, t_fe0e6a0b98 suite) doit partir en QUERY
    PARAM sur l'URL PATCH, jamais dans le body — cf plan/lba_api.py::
    me_update_evenement où `source` est un paramètre de fonction séparé de
    `payload: dict` (donc résolu par FastAPI comme query param, pas Body)."""

    def setUp(self):
        self._orig_patch = lba_cli._patch
        self._orig_auth = lba_cli._auth_headers

        def fake_patch(path, payload, headers=None):
            raise CapturedPatch(path, payload)

        # lba_visite_modifier est un tool GRAPH/TODO (auth réelle exigée,
        # ticket-exchange réseau) — sans ce mock, _exec échoue avant même
        # d'atteindre _patch (HTTP 403, pas de seat business pour ce test).
        lba_cli._patch = fake_patch
        lba_cli._auth_headers = lambda tool, agent_id: {}

    def tearDown(self):
        lba_cli._patch = self._orig_patch
        lba_cli._auth_headers = self._orig_auth

    def _captured(self, args):
        with self.assertRaises(CapturedPatch) as ctx:
            lba_cli._exec("lba_visite_modifier", args)
        return ctx.exception

    def test_source_cr_live_appended_as_query_param(self):
        cap = self._captured({"es_id": 42, "observations": "texte en cours", "source": "cr_live"})
        self.assertEqual(cap.path, "/api/me/evenements/42?source=cr_live")
        self.assertNotIn("source", cap.payload)  # jamais dans le body

    def test_source_absent_by_default_unchanged_path(self):
        cap = self._captured({"es_id": 42, "observations": "modification manuelle"})
        self.assertEqual(cap.path, "/api/me/evenements/42")
        self.assertNotIn("source", cap.payload)


class CapturedPost(Exception):
    """Utilisé pour court-circuiter _post et récupérer (path, payload) sans HTTP."""

    def __init__(self, path, payload):
        self.path = path
        self.payload = payload


class TestT19HarmonisationAppliquerCodeArticle(unittest.TestCase):
    """code_article (mission plan_86fc8ff8, 2026-08-04) : payload transmis à la
    route backend /api/bacchus/tarifs/t19-harmonisation/appliquer DOIT refléter
    EXACTEMENT le contrat déjà câblé côté LBA-DESKTOP (commit 246e1e3) — même
    nom de champ (code_article), sous_famille=None quand code_article est
    fourni seul, aucune invention d'un contrat CLI distinct."""

    def setUp(self):
        self._orig_post = lba_cli._post

        def fake_post(path, payload, headers=None):
            raise CapturedPost(path, payload)

        lba_cli._post = fake_post

    def tearDown(self):
        lba_cli._post = self._orig_post

    def _captured(self, args):
        with self.assertRaises(CapturedPost) as ctx:
            lba_cli._exec("lba_tarifs_t19_harmonisation_appliquer", args)
        return ctx.exception

    def test_code_article_seul_transmet_sous_famille_none(self):
        cap = self._captured({
            "agent_id": "22fcf4a5-agent-1", "code_article": "3442",
            "r1_cible": 0.15, "confirm": True,
        })
        self.assertEqual(cap.path, "/api/bacchus/tarifs/t19-harmonisation/appliquer")
        self.assertEqual(cap.payload["code_article"], "3442")
        self.assertIsNone(cap.payload["sous_famille"])
        self.assertEqual(cap.payload["r1_cible"], 0.15)
        self.assertEqual(cap.payload["r2_cible"], 0.0)  # défaut
        self.assertTrue(cap.payload["confirm"])

    def test_sous_famille_seule_transmet_code_article_none(self):
        """Non-régression du mode historique : code_article absent -> None
        transmis explicitement (pas un champ manquant côté payload)."""
        cap = self._captured({
            "agent_id": "22fcf4a5-agent-1", "sous_famille": "BLONDE",
            "r1_cible": 0.15, "confirm": True,
        })
        self.assertEqual(cap.payload["sous_famille"], "BLONDE")
        self.assertIsNone(cap.payload["code_article"])

    def test_num_tarif_cible_et_r2_cible_defauts_inchanges_en_mode_article(self):
        cap = self._captured({
            "agent_id": "22fcf4a5-agent-1", "code_article": "3442", "r1_cible": 0.0, "confirm": True,
        })
        self.assertEqual(cap.payload["num_tarif_cible"], 18)
        self.assertEqual(cap.payload["r2_cible"], 0.0)


class TestAchatsBlDeduireTaxesCalculees(unittest.TestCase):
    """P1 signalé Ivan via Pierre (msg_ref=91571b5f3457, plan_b4be7a9b) : le
    tool n'était jamais câblé dans le registre CLI (0 résultat sur `deduire`
    dans bin/lba avant ce commit — diagnostic confirmé ledger l_a1165b0613).
    Verrouille le contrat POST exact attendu côté backend
    (LBA-DESKTOP/plan/bacchus_achats_tools.py:249, DeduireTaxesCalculees)."""

    def setUp(self):
        self._orig_post = lba_cli._post

        def fake_post(path, payload, headers=None):
            raise CapturedPost(path, payload)

        lba_cli._post = fake_post

    def tearDown(self):
        lba_cli._post = self._orig_post

    def _captured(self, args):
        with self.assertRaises(CapturedPost) as ctx:
            lba_cli._exec("lba_achats_bl_deduire_taxes_calculees", args)
        return ctx.exception

    def test_transmet_code_article_et_prix_incluant_taxes(self):
        cap = self._captured({"code_article": "3337", "prix_incluant_taxes": 12.5})
        self.assertEqual(cap.path, "/api/bacchus/achats/facturation/deduire-taxes-calculees")
        self.assertEqual(cap.payload, {"code_article": "3337", "prix_incluant_taxes": 12.5})

    def test_code_article_manquant_leve(self):
        with self.assertRaises(lba_cli.LbaCliError):
            lba_cli._exec("lba_achats_bl_deduire_taxes_calculees", {"prix_incluant_taxes": 12.5})

    def test_prix_incluant_taxes_manquant_leve(self):
        with self.assertRaises(lba_cli.LbaCliError):
            lba_cli._exec("lba_achats_bl_deduire_taxes_calculees", {"code_article": "3337"})


class TestCliSurface(unittest.TestCase):
    def test_list_returns_18_tools(self):
        out = subprocess.run(
            [sys.executable, BIN_LBA, "--list"],
            capture_output=True, text=True, timeout=10, check=True,
        )
        tools = json.loads(out.stdout)
        # Historique (18 DATA M2 + 41 Graph/Todo + devis/tarif audit + 9 Teams
        # + 6 Outlook + lba_mail_marquer) documentait 77 -- DRIFT PRÉ-EXISTANT
        # DÉCOUVERT ICI (mission #4 plan_c5ebf394, 2026-08-04) : la baseline
        # RÉELLE avant cette mission était déjà 87 (vérifié via `bin/lba --list`
        # sur HEAD avant tout changement + confirmé par git stash -- ce test
        # échouait déjà 87 != 77 avant ma propre extension, aucun rapport avec
        # les tools que j'ajoute). Le detail exact des tools non comptabilisés
        # dans les 77 documentés n'a pas été ré-audité ligne à ligne ici (hors
        # scope de cette mission, dont le seul livrable est lba_articles_liste)
        # -- signalé au Chef d'Atelier plutôt que corrigé silencieusement.
        # 87 (baseline réelle mesurée) + lba_articles_liste (mission #4,
        # cablage CLI du endpoint backend GET /api/bacchus/articles/liste,
        # mission #1, commit LBA-DESKTOP 9c4a977) + lba_clients_filtre
        # (mission #2, cablage CLI du endpoint backend GET
        # /api/bacchus/clients/filtre, commit LBA-DESKTOP 7ae5d34) = 89
        # (les deux missions du sprint plan_c5ebf394 mergées ensemble sur
        # ubik-mcp main, chacune ajoutant son propre tool CLI).
        # 89 + lba_memoire_save + lba_memoire_recall (LBA MEMORY, plan écrit
        # 2026-08-04, demande explicite Damien — cablage CLI de
        # POST/GET /api/bacchus/memoire/{save,recall}, backend
        # LBA-DESKTOP/plan/bacchus_memoire_tools.py) = 91.
        # DRIFT PRÉ-EXISTANT DÉCOUVERT ICI (plan_9a274922, 2026-08-17,
        # mission wrapper CLI audit-facturation) : la baseline RÉELLE sur
        # HEAD avant cette mission était déjà 102 (`bin/lba --list` +
        # `git stash`, même méthode que le drift du 2026-08-04 ci-dessus),
        # pas 91 — beaucoup de tools ajoutés depuis sans mise à jour de ce
        # test. Non ré-audité ligne à ligne (hors scope, seul livrable ici
        # = lba_audit_facturation) — signalé au Chef d'Atelier plutôt que
        # corrigé silencieusement, même doctrine que le drift précédent.
        # 102 (baseline réelle mesurée) + lba_audit_facturation = 103.
        # 103 + lba_avoir_simuler + lba_avoir_creer (plan_d9a888da, mission
        # Phase 4 — enregistrement CLI des avoirs PrismaSoft, backend
        # LBA-DESKTOP/plan/bacchus_avoir_tools.py déjà livré + gate Orion
        # approuvé) = 105.
        # DRIFT PRÉ-EXISTANT DÉCOUVERT ICI (plan_a7c60f1c, 2026-08-21,
        # mission #4 Import BL) : la baseline RÉELLE sur HEAD avant cette
        # mission était déjà 108 (`bin/lba --list` + `git stash`, même
        # méthode que les drifts précédents ci-dessus), pas 105 — tools
        # ajoutés depuis sans mise à jour de ce test. Non ré-audité ligne à
        # ligne (hors scope, seul livrable ici = les 4 tools Import BL) —
        # signalé au Chef d'Atelier plutôt que corrigé silencieusement,
        # même doctrine que les drifts précédents.
        # 108 (baseline réelle mesurée) + lba_achats_bl_lignes_non_imputees
        # + lba_achats_bl_resoudre_reference + lba_achats_bl_importer_lignes
        # + lba_achats_bl_tracer_resolution_forcee (mission #4, cablage CLI
        # du flux Import BL, backend LBA-DESKTOP/plan/bacchus_achats_
        # tools.py déjà livré mission #3, commit 2dad43e) = 112.
        # + lba_achats_bl_modifier_entete (plan_eb472683, 2026-08-21,
        # mission #4 follow-up Import BL : cablage CLI de
        # modifier_entete_facture_fournisseur, backend prisma-api déjà
        # livré commit cd413a1 — AVERTISSEMENT : le wrapper LBA-DESKTOP/
        # plan/bacchus_achats_tools.py::POST /api/bacchus/achats/
        # facturation/modifier-entete que ce tool appelle N'EXISTE PAS
        # ENCORE (vérifié : grep exhaustif sur le worktree LBA-DESKTOP
        # assigné, 0 résultat) — cet enregistrement CLI seul ne rend PAS
        # le tool fonctionnel bout-en-bout tant que ce wrapper manquant
        # n'est pas livré séparément, cf rapport de mission) = 113.
        # + lba_achats_bl_lire_entete (plan_101221aa, 2026-08-21, mission
        # #3 volet 3 : cablage CLI de lire_entete_facture_fournisseur,
        # lecture pure, backend prisma-api déjà livré commit 2abd423, ET
        # wrapper LBA-DESKTOP déjà livré dans la MÊME vague (commit
        # cbdf231, GET /api/bacchus/achats/facturation/lire-entete) — ce
        # tool EST fonctionnel bout-en-bout dès ce commit, contrairement
        # à l'avertissement ci-dessus sur modifier-entete) = 114.
        # DRIFT PRÉ-EXISTANT DÉCOUVERT ICI (plan_b4be7a9b, 2026-08-25,
        # mission P1 signalé Ivan — deduire-taxes-calculees jamais câblé) :
        # la baseline RÉELLE sur HEAD avant cette mission était déjà 134
        # (`bin/lba --list` + `git stash`, même méthode que tous les drifts
        # précédents ci-dessus), pas 114 — beaucoup de tools ajoutés depuis
        # sans mise à jour de ce test. Non ré-audité ligne à ligne (hors
        # scope, seul livrable ici = lba_achats_bl_deduire_taxes_calculees)
        # — signalé au Chef d'Atelier plutôt que corrigé silencieusement,
        # même doctrine que tous les drifts précédents.
        # 134 (baseline réelle mesurée) + lba_achats_bl_deduire_taxes_
        # calculees (P1 signalé Ivan via Pierre, msg_ref=91571b5f3457 :
        # POST /achats/facturation/deduire-taxes-calculees existait déjà
        # côté backend, ledger l_c6a4e12535, mais n'avait JAMAIS été câblé
        # dans le registre CLI — diagnostic confirmé ledger l_a1165b0613)
        # = 135.
        # BASELINE VÉRIFIÉE (carte t_710b1c78d3, plan_425ab05c, mission #2,
        # 2026-08-26, `bin/lba --list` + `git stash`, même méthode que tous
        # les drifts ci-dessus) : 135 sur HEAD avant cette mission — AUCUN
        # drift détecté cette fois, la valeur documentée correspondait déjà
        # à la réalité. 135 + lba_whatsapp_envoyer (mirroir lba_mail_envoyer,
        # gate d'envoi WhatsApp VERT/ORANGE/ROUGE, backend
        # LBA-DESKTOP/plan/bacchus_whatsapp_envoyer.py déjà livré mission
        # #1, commit LBA-DESKTOP 2fe78ab) = 136.
        # DRIFT PRÉ-EXISTANT DÉCOUVERT ICI (t_eafa2f3ea0, 2026-08-29, audit
        # qualité synthèse Calypso "KPI de visites") : `git stash` + `bin/lba
        # --list` sur HEAD avant cette mission mesure 147, pas 136 — 11 tools
        # ajoutés depuis (commit "Ajoute 7 tools Q&R lecture seule Terrain &
        # Visites / Planning (Tier 1)" notamment) sans mise à jour de ce
        # test. Non ré-audité ligne à ligne (hors scope, seul livrable ici =
        # lba_visites_value_key), signalé au Chef d'Atelier plutôt que
        # corrigé silencieusement, même doctrine que tous les drifts
        # précédents. 147 (baseline réelle mesurée) + lba_visites_value_key
        # (GET /api/me/evenements/value-key, complète les 4 piliers d'une
        # synthèse KPI de visites — cf lba_visites_kpis) = 148.
        # BASELINE VÉRIFIÉE (t_eafa2f3ea0, 2026-08-29, carte "Clients inactifs"
        # scindée de "Clients à relancer") : `git stash` + `bin/lba --list`
        # mesure 148 sur HEAD avant cette mission — AUCUN drift, la valeur
        # documentée correspondait déjà à la réalité. 148 + lba_clients_inactifs
        # (GET /api/me/clients-inactifs, nouveau — clients sans commande sur la
        # période, distinct de lba_clients_sous_visites qui porte sur les
        # visites) = 149.
        self.assertEqual(len(tools), 149)
        names = {t["name"] for t in tools}
        self.assertIn("lba_client_fiche", names)
        self.assertIn("lba_rep_codes", names)
        self.assertIn("lba_avoir_simuler", names)
        self.assertIn("lba_avoir_creer", names)
        self.assertIn("lba_articles_liste", names)
        self.assertIn("lba_clients_filtre", names)
        self.assertIn("lba_achats_bl_lignes_non_imputees", names)
        self.assertIn("lba_achats_bl_resoudre_reference", names)
        self.assertIn("lba_achats_bl_importer_lignes", names)
        self.assertIn("lba_achats_bl_tracer_resolution_forcee", names)
        self.assertIn("lba_achats_bl_modifier_entete", names)
        self.assertIn("lba_achats_bl_lire_entete", names)
        self.assertIn("lba_achats_bl_deduire_taxes_calculees", names)

    def test_schema_prints_valid_json_schema(self):
        out = subprocess.run(
            [sys.executable, BIN_LBA, "lba_client_fiche", "--schema"],
            capture_output=True, text=True, timeout=10, check=True,
        )
        schema = json.loads(out.stdout)
        self.assertEqual(schema["type"], "object")
        self.assertIn("code", schema["required"])


if __name__ == "__main__":
    unittest.main()
