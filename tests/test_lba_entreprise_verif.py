#!/usr/bin/env python3
"""lba_entreprise_verifier / lba_page_publique_lire (sprint 2 · C, 2026-10-22) : définitions, chemins, passthrough, identité du seat.
Le CLI ne fait AUCUNE sortie réseau vers l'extérieur : il appelle seulement le backend (garde-fous SSRF = plan/bacchus_entreprise_verif_tools.py)."""
import importlib.util
import os
import unittest
from importlib.machinery import SourceFileLoader

BIN_LBA = os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "bin", "lba")
_loader = SourceFileLoader("lba_cli_verif", BIN_LBA)
lba_cli = importlib.util.module_from_spec(importlib.util.spec_from_loader("lba_cli_verif", _loader))
_loader.exec_module(lba_cli)
lba_cli._mint_cli_session_jwt = lambda agent_id: "jwt-du-seat"
lba_cli._cached_session_jwt = lambda agent_id: lba_cli._mint_cli_session_jwt(agent_id)


class Capture(Exception):
    pass


class TestVerificationExterne(unittest.TestCase):
    def setUp(self):
        self._get = lba_cli._get

        def fake_get(path, params, headers=None, timeout=30):
            raise Capture({"path": path, "params": params, "headers": headers, "timeout": timeout})
        lba_cli._get = fake_get

    def tearDown(self):
        lba_cli._get = self._get

    def _appel(self, tool, args):
        with self.assertRaises(Capture) as c:
            lba_cli._exec(tool, args)
        return c.exception.args[0]

    def test_verifier_chemin_params_et_jeton_du_titulaire(self):
        r = self._appel("lba_entreprise_verifier", {"rna": "W691234567"})
        self.assertEqual(r["path"], "/api/bacchus/entreprise/verifier")
        self.assertEqual(r["params"], {"siret": None, "siren": None, "rna": "W691234567", "q": None})
        self.assertEqual(r["headers"], {"Authorization": "Bearer jwt-du-seat"})

    def test_page_publique_chemin_url_obligatoire(self):
        r = self._appel("lba_page_publique_lire", {"url": "https://www.insee.fr/fr/accueil"})
        self.assertEqual(r["path"], "/api/bacchus/page-publique/lire")
        self.assertEqual(r["params"], {"url": "https://www.insee.fr/fr/accueil"})
        self.assertEqual(r["headers"], {"Authorization": "Bearer jwt-du-seat"})
        with self.assertRaises(lba_cli.LbaCliError):
            lba_cli._exec("lba_page_publique_lire", {})

    def test_definitions_lecture_seule_et_mise_en_garde(self):
        outils = {t["name"]: t for t in lba_cli.TOOLS}
        for nom in ("lba_entreprise_verifier", "lba_page_publique_lire"):
            d = outils[nom]["description"]
            self.assertIn("NON FIABLE", d)
            self.assertIn("GET /api/bacchus/", d)
            self.assertNotIn("confirm", outils[nom]["inputSchema"].get("properties", {}))
        self.assertEqual(outils["lba_page_publique_lire"]["inputSchema"]["required"], ["url"])


if __name__ == "__main__":
    unittest.main()
