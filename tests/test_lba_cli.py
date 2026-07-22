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


class TestCliSurface(unittest.TestCase):
    def test_list_returns_18_tools(self):
        out = subprocess.run(
            [sys.executable, BIN_LBA, "--list"],
            capture_output=True, text=True, timeout=10, check=True,
        )
        tools = json.loads(out.stdout)
        self.assertEqual(len(tools), 18)
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
