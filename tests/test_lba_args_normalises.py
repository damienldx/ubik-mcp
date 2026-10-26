"""Paramètres inconnus : alias courants → nom exact, sinon erreur qui liste les paramètres valides (pas d'appel émis)."""
import importlib.util
import unittest
from importlib.machinery import SourceFileLoader

_loader = SourceFileLoader("lba_cli_args", __file__.replace("tests/test_lba_args_normalises.py", "bin/lba"))
lba = importlib.util.module_from_spec(importlib.util.spec_from_loader("lba_cli_args", _loader))
_loader.exec_module(lba)


class ArgsNormalises(unittest.TestCase):
    def test_alias_recherche_vers_q(self):
        self.assertEqual(lba._normaliser_args("lba_prospects_filtre", {"recherche": "VILLAGE"}), {"q": "VILLAGE"})

    def test_alias_q_vers_query_pour_capacites(self):
        self.assertEqual(lba._normaliser_args("lba_capacites_rechercher", {"q": "visite"}), {"query": "visite"})

    def test_parametre_inconnu_liste_les_parametres_valides(self):
        with self.assertRaises(lba.LbaCliError) as cm:
            lba._normaliser_args("lba_prospects_filtre", {"ville": "Paris"})
        msg = str(cm.exception)
        self.assertIn("'ville'", msg)
        self.assertIn("q", msg)
        self.assertIn("Aucune requête émise", msg)

    def test_parametres_valides_inchanges_et_hors_schema_tolere(self):
        args = {"q": "x", "limit": 5, "agent_id": "a", "confirmed_by_user": True}
        self.assertEqual(lba._normaliser_args("lba_prospects_filtre", args), args)

    def test_fiche_client_dates_facultatives(self):
        props = lba._TOOLS_BY_NAME["lba_client_fiche"]["inputSchema"]
        self.assertEqual(props["required"], ["code"])

    def test_tous_les_schemas_ont_des_proprietes_pour_la_verification(self):
        for t in lba.TOOLS:
            self.assertIn("properties", t["inputSchema"], t["name"])


if __name__ == "__main__":
    unittest.main()
