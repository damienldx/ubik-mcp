#!/usr/bin/env python3
"""Filtre de tier par seat de bin/lba : union des mandats de la carte
(whitelist - blacklist du MEME mandat), seat hub = sa carte + celle du seat
portail du meme slot, usurpation d'identite refusee, echec ferme."""
import importlib.util
import json
import os
import tempfile
import unittest
from importlib.machinery import SourceFileLoader

import yaml

HERE = os.path.dirname(os.path.realpath(__file__))
_loader = SourceFileLoader("lba_cli_tier", os.path.join(HERE, "..", "bin", "lba"))
lba = importlib.util.module_from_spec(importlib.util.spec_from_loader("lba_cli_tier", _loader))
_loader.exec_module(lba)


class TierFilter(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.d, "mandats"))
        os.environ["LBA_AUTOPIPES_DIR"] = self.d
        self._env = {k: os.environ.get(k) for k in ("UBIK_AGENT_ID", "RELAY_AGENT_ID")}
        os.environ.pop("RELAY_AGENT_ID", None)

    def tearDown(self):
        os.environ.pop("LBA_AUTOPIPES_DIR", None)
        for k, v in self._env.items():
            os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)

    def mandate(self, mid, wl, bl=()):
        with open(os.path.join(self.d, "mandats", f"{mid}.yaml"), "w") as f:
            yaml.safe_dump({"tools_whitelist": list(wl), "tools_blacklist": list(bl)}, f)

    def cart(self, agent_id, *mids):
        with open(os.path.join(self.d, f"cart_{agent_id}.json"), "w") as f:
            json.dump({"items": [{"type": "mandat", "id": m} for m in mids]}, f)

    def call(self, seat, tool, args=None, agent_id=None):
        os.environ["UBIK_AGENT_ID"] = seat
        lba._enforce_tool_tier(tool, args or {}, agent_id)

    def test_employee_refused_outside_whitelist(self):
        self.mandate("lba-seat", ["a", "b"], ["c"])
        self.cart("22fcf4a5-agent-6", "lba-seat")
        self.call("22fcf4a5-agent-6", "a")
        with self.assertRaises(lba.LbaCliError):
            self.call("22fcf4a5-agent-6", "c")

    def test_addon_not_blocked_by_base_blacklist(self):
        self.mandate("lba-seat", ["a"], ["c"])
        self.mandate("lba-direction", ["c"])
        self.cart("22fcf4a5-agent-9", "lba-seat", "lba-direction")
        self.call("22fcf4a5-agent-9", "c")

    def test_hub_seat_cumulates_portal_cart(self):
        self.mandate("lba-hub-orchestrateur", [])
        self.mandate("lba-seat", ["a"])
        self.cart("281cc61f-agent-6", "lba-hub-orchestrateur")
        self.cart("22fcf4a5-agent-6", "lba-seat")
        self.call("281cc61f-agent-6", "a")
        with self.assertRaises(lba.LbaCliError):
            self.call("281cc61f-agent-6", "z")

    def test_impersonation_refused(self):
        self.mandate("lba-seat", ["a"])
        self.cart("22fcf4a5-agent-6", "lba-seat")
        with self.assertRaises(lba.LbaCliError):
            self.call("22fcf4a5-agent-6", "a", agent_id="22fcf4a5-agent-9")
        with self.assertRaises(lba.LbaCliError):
            self.call("22fcf4a5-agent-6", "a", args={"agent_id": "22fcf4a5-agent-9"})

    def test_non_seat_and_no_lba_mandate_unrestricted(self):
        self.call("6da176c2-agent-0", "anything")
        self.mandate("corporate-lead", ["a"])
        self.cart("22fcf4a5-agent-0", "corporate-lead")
        self.call("22fcf4a5-agent-0", "anything")

    def test_fail_closed_on_missing_manifest_or_bad_cart(self):
        self.cart("22fcf4a5-agent-6", "lba-seat")  # manifest absent
        with self.assertRaises(lba.LbaCliError):
            self.call("22fcf4a5-agent-6", "a")
        with open(os.path.join(self.d, "cart_22fcf4a5-agent-3.json"), "w") as f:
            f.write("{not json")
        with self.assertRaises(lba.LbaCliError):
            self.call("22fcf4a5-agent-3", "a")


if __name__ == "__main__":
    unittest.main()


class HubReadOnly(unittest.TestCase):
    """Les seats du vehicule hub ne peuvent pas ecrire via le CLI."""

    def setUp(self):
        self._env = os.environ.get("UBIK_AGENT_ID")
        self.d = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.d, "mandats"))
        os.environ["LBA_AUTOPIPES_DIR"] = self.d
        with open(os.path.join(self.d, "mandats", "lba-seat.yaml"), "w") as f:
            yaml.safe_dump({"tools_whitelist": [t["name"] for t in lba.TOOLS]}, f)
        for cid in ("22fcf4a5-agent-9", "281cc61f-agent-9"):
            with open(os.path.join(self.d, f"cart_{cid}.json"), "w") as f:
                json.dump({"items": [{"type": "mandat", "id": "lba-seat"}]}, f)

    def tearDown(self):
        os.environ.pop("LBA_AUTOPIPES_DIR", None)
        os.environ.pop("UBIK_AGENT_ID", None) if self._env is None else os.environ.__setitem__("UBIK_AGENT_ID", self._env)

    def enforce(self, seat, tool):
        os.environ["UBIK_AGENT_ID"] = seat
        lba._enforce_tool_tier(tool, {}, None)

    def test_hub_refuse_les_ecritures(self):
        for tool in ("lba_todo_task_create", "lba_avoir_creer", "lba_mail_envoyer", "lba_client_blocage",
                     "lba_recouvrement_ecrire", "lba_paniers_abandonnes_purger", "lba_calendar_creer"):
            with self.assertRaises(lba.LbaCliError, msg=tool):
                self.enforce("281cc61f-agent-9", tool)

    def test_hub_laisse_lectures_simulateurs_et_fichiers_locaux(self):
        for tool in ("lba_recherche_client", "lba_avoir_simuler", "lba_mail_liste", "lba_relance_blocage_eligibles",
                     "lba_document_envoyer_client_preparer", "lba_document_generer_pdf", "lba_memoire_save",
                     "lba_capacites_rechercher", "lba_todo_tasks"):
            self.enforce("281cc61f-agent-9", tool)

    def test_portail_non_concerne(self):
        self.enforce("22fcf4a5-agent-9", "lba_todo_task_create")

    def test_liste_du_hub_sans_ecritures(self):
        os.environ["UBIK_AGENT_ID"] = "281cc61f-agent-9"
        names = {t["name"] for t in lba._visible_tools()}
        self.assertNotIn("lba_avoir_creer", names)
        self.assertIn("lba_avoir_simuler", names)
        self.assertGreater(len(names), 150)
