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


class TestCliSurface(unittest.TestCase):
    def test_list_returns_18_tools(self):
        out = subprocess.run(
            [sys.executable, BIN_LBA, "--list"],
            capture_output=True, text=True, timeout=10, check=True,
        )
        tools = json.loads(out.stdout)
        # 18 DATA (M2) + 41 Graph/Todo (M3 + plan_91c9dfb4 + plan_13812401 + procedures 7
        # + visites 2 + reunions 6 + reunions dossiers 2 + todo delete/due 2, 2026-07-26
        # + devis assistés Bacchus 9, plan_9a6dda04 wave1, 2026-07-30
        # + lba_client_tarif + lba_client_remises_negociees, 2026-07-30, audit trous info
        # tarifaire Bacchus signalé Damien)
        # + 9 tools Teams (lire_messages/demarrer/nouveautes/lister_equipes/lister_canaux/
        # lire_canal_messages/presence/lister_reunions/reunion_detail), 2026-08-02,
        # sprint Bacchus Teams tools plan_b47aeb6d
        self.assertEqual(len(tools), 70)
        names = {t["name"] for t in tools}
        self.assertIn("lba_client_fiche", names)
        self.assertIn("lba_rep_codes", names)

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
