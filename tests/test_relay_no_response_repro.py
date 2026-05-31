#!/usr/bin/env python3
"""Repro + regression test for the relay 'no response' double-send bug.

Bug: bin/ubik `_stdio_call` used subprocess.run(input=..), which closes stdin
right after writing. The MCP stdio server (FastMCP, mcp_relay.py) sees EOF and
tears down the session, racing the in-flight request handler's response write.
The server STARTS the call (its side effect — a relay /send enqueue — fires =
"DM delivered") but the JSON-RPC id=2 reply is dropped before flush, so
`_stdio_call` raised "no response from ..." ~10% of the time => the caller
double-sent an already-delivered DM.

Fix: client-driven lifecycle — keep stdin OPEN, read stdout until the id=2 reply
arrives, THEN close stdin / terminate. The response write always happens first.

This test runs the OLD logic (control, expected to flake) and the PATCHED
`_stdio_call` loaded from bin/ubik (expected 0 failures), against the LIVE relay
using the read-only relay_whoami tool (zero radio pollution). Exits non-zero if
the patched arm flakes at all.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
BIN_UBIK = os.path.join(HERE, "..", "bin", "ubik")
REAL_HOME = "/home/damienldx"
RELAY_CMD = ["python3", os.path.join(REAL_HOME,
             "workspace/ubik-fleet/fleet/starters/mcp_relay.py")]
AID = os.environ.get("RELAY_AGENT_ID", "6da176c2-agent-3")
N = int(os.environ.get("REPRO_N", "30"))

WHOAMI = {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
          "params": {"name": "relay_whoami", "arguments": {"agent_id": AID}}}


def _base_env():
    env = dict(os.environ)
    env["HOME"] = REAL_HOME
    env["RELAY_AGENT_ID"] = AID
    return env


def old_stdio_call(command, request):
    """Pre-fix logic: subprocess.run closes stdin immediately (the race)."""
    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                       "clientInfo": {"name": "ubik-cli", "version": "1"}}}
    inited = {"jsonrpc": "2.0", "method": "notifications/initialized"}
    stdin = "\n".join(json.dumps(m) for m in (init, inited, request)) + "\n"
    proc = subprocess.run(command, input=stdin, capture_output=True, text=True,
                          timeout=120, env=_base_env())
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            m = json.loads(line)
        except json.JSONDecodeError:
            continue
        if m.get("id") == 2:
            return m
    raise RuntimeError("no response")


def load_patched_stdio_call():
    """Exec bin/ubik with __name__ != __main__, override path globals to point
    at the operator install, and return its _stdio_call."""
    ns = {"__name__": "ubik_under_test", "__file__": os.path.realpath(BIN_UBIK)}
    with open(BIN_UBIK) as f:
        exec(compile(f.read(), BIN_UBIK, "exec"), ns)
    ns["_REAL_HOME"] = REAL_HOME
    ns["REPO"] = os.path.join(REAL_HOME, "workspace/ubik-mcp")
    return ns["_stdio_call"]


def run_arm(name, fn, n):
    fails = 0
    for _ in range(n):
        try:
            r = fn(RELAY_CMD, dict(WHOAMI))
            if not (isinstance(r, dict) and r.get("id") == 2):
                fails += 1
        except Exception:
            fails += 1
    print(f"  {name:<18} {n - fails}/{n} ok, {fails} failures")
    return fails


def main():
    print(f"Relay 'no response' repro — {N} iterations/arm, tool=relay_whoami (read-only)")
    patched = load_patched_stdio_call()
    old_fails = run_arm("OLD (control)", old_stdio_call, N)
    new_fails = run_arm("PATCHED", patched, N)
    print()
    if new_fails:
        print(f"FAIL: patched _stdio_call flaked {new_fails}/{N} — bug NOT fixed")
        sys.exit(1)
    if not old_fails:
        print(f"WARN: control arm did not flake this run (race is timing-dependent); "
              f"patched arm clean ({new_fails}/{N}). Re-run to observe the flake.")
    else:
        print(f"PASS: control flaked {old_fails}/{N}, patched 0/{N} — fix validated.")
    sys.exit(0)


if __name__ == "__main__":
    main()
