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
