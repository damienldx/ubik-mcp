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
            lba._normaliser_args("lba_prospects_filtre", {"region": "Paris"})
        msg = str(cm.exception)
        self.assertIn("'region'", msg)
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


class VilleEtSortie(unittest.TestCase):
    def setUp(self):
        self.appels = []
        self._sauve = (lba._get, lba._auth_headers, lba._enforce_tool_tier)
        lba._get = lambda path, params=None, *a, **k: self.appels.append((path, params)) or "{}"
        lba._auth_headers = lambda *a, **k: {}
        lba._enforce_tool_tier = lambda *a, **k: None

    def tearDown(self):
        lba._get, lba._auth_headers, lba._enforce_tool_tier = self._sauve

    def test_clients_filtre_avec_ville_delegue_a_la_recherche_par_ville(self):
        lba._exec("lba_clients_filtre", {"ville": "Fontenay sous Bois", "is_actif": False})
        path, p = self.appels[0]
        self.assertEqual(path, "/api/bacchus/recherche/client_par_ville")
        self.assertEqual((p["type"], p["is_actif"], p["limit"]), ("client", "false", 50))

    def test_prospects_filtre_avec_ville_sans_statut_prend_tous(self):
        lba._exec("lba_prospects_filtre", {"ville": "Paris"})
        self.assertEqual((self.appels[0][1]["type"], self.appels[0][1]["is_actif"]), ("prospect", "tous"))

    def test_clients_par_ville_defaut_actif_et_statut_inactif(self):
        lba._exec("lba_clients_par_ville", {"ville": "Paris"})
        lba._exec("lba_clients_par_ville", {"ville": "Paris", "statut": "inactif", "type": "tous"})
        self.assertEqual(self.appels[0][1]["is_actif"], "true")
        self.assertEqual((self.appels[1][1]["is_actif"], self.appels[1][1]["type"]), ("false", "tous"))

    def test_ville_incompatible_avec_famille(self):
        with self.assertRaises(lba.LbaCliError):
            lba._exec("lba_clients_filtre", {"ville": "Paris", "famille": "CHR"})
        self.assertEqual(self.appels, [])

    def test_sortie_trop_grosse_raccourcie_explicitement(self):
        gros = {"total": 900, "items": [{"i": i, "pad": "x" * 200} for i in range(900)]}
        import json
        sortie = json.loads(lba._borner_sortie(gros))
        self.assertTrue(sortie["tronque"] and sortie["restant"] == 900 - sortie["retournees"] and "offset" in sortie["note"])
        self.assertLessEqual(len(lba._borner_sortie(gros)), lba._SORTIE_MAX_CAR)
        petit = {"total": 1, "items": [{"i": 1}]}
        self.assertEqual(json.loads(lba._borner_sortie(petit)), petit)


class ParcoursDetail(unittest.TestCase):
    def test_outil_declare_et_lecture_pure(self):
        t = lba._TOOLS_BY_NAME["lba_parcours_detail"]
        self.assertEqual(set(t["inputSchema"]["properties"]), {"id", "q"})
        self.assertFalse(lba._is_write_tool("lba_parcours_detail"))

    def test_sans_id_ni_q_refuse_avant_tout_appel(self):
        sauve = (lba._auth_headers, lba._enforce_tool_tier)
        lba._auth_headers = lambda *a, **k: {}
        lba._enforce_tool_tier = lambda *a, **k: None
        try:
            with self.assertRaises(lba.LbaCliError):
                lba._exec("lba_parcours_detail", {})
        finally:
            lba._auth_headers, lba._enforce_tool_tier = sauve


class AliasCode(unittest.TestCase):
    def test_client_devient_code_quand_l_outil_attend_code(self):
        self.assertEqual(lba._normaliser_args("lba_client_fiche", {"client": "1204"}), {"code": "1204"})
        self.assertEqual(lba._normaliser_args("lba_client_fiche", {"code_client": "1204", "date_from": "2026-01-01"}),
                         {"code": "1204", "date_from": "2026-01-01"})

    def test_pas_d_alias_si_code_deja_present(self):
        with self.assertRaises(lba.LbaCliError):
            lba._normaliser_args("lba_client_fiche", {"client": "1", "code": "2"})


class AliasDatesEtResume(unittest.TestCase):
    def test_date_debut_fin_vers_period(self):
        self.assertEqual(lba._normaliser_args("lba_visites_liste", {"date_debut": "2026-10-23", "date_fin": "2026-10-23"}),
                         {"period_start": "2026-10-23", "period_end": "2026-10-23"})

    def test_period_vers_date_selon_l_outil(self):
        self.assertEqual(lba._normaliser_args("lba_client_fiche", {"code": "1", "period_start": "2026-01-01", "date_fin": "2026-02-01"}),
                         {"code": "1", "date_from": "2026-01-01", "date_to": "2026-02-01"})

    def test_resume_declare_et_regrouper_par(self):
        self.assertEqual(lba._TOOLS_BY_NAME["lba_clients_resume"]["inputSchema"]["required"], ["codes"])
        self.assertIn("regrouper_par", lba._TOOLS_BY_NAME["lba_clients_sous_visites"]["inputSchema"]["properties"])
        self.assertFalse(lba._is_write_tool("lba_clients_resume"))

    def test_resume_accepte_une_liste_et_envoie_un_seul_appel(self):
        appels = []
        sauve = (lba._get, lba._auth_headers, lba._enforce_tool_tier)
        lba._get = lambda path, params=None, *a, **k: appels.append((path, params)) or "{}"
        lba._auth_headers = lambda *a, **k: {}
        lba._enforce_tool_tier = lambda *a, **k: None
        try:
            lba._exec("lba_clients_resume", {"codes": ["1204", " 1044 "]})
            with self.assertRaises(lba.LbaCliError):
                lba._exec("lba_clients_resume", {"codes": []})
        finally:
            lba._get, lba._auth_headers, lba._enforce_tool_tier = sauve
        self.assertEqual(appels, [("/api/bacchus/clients/resume", {"codes": "1204,1044", "days": 365})])
