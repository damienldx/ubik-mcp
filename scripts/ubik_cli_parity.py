#!/usr/bin/env python3
"""Parity: `ubik <ns> <tool>` (CLI) vs the live MCP gateway (:8902) for the same
tool. Proxy namespaces (agent->:8765, engine->:8801) forward to the same backend
the gateway proxies, so results must match semantically (JSON-parsed; volatile
timing fields normalized). Standalone, run on dev-station-02:
    python3 ~/workspace/ubik-mcp/scripts/ubik_cli_parity.py
"""
import json, os, subprocess, sys, urllib.request

GW = "http://127.0.0.1:8902/mcp"
U = os.path.expanduser("~/.local/bin/ubik")
VOLATILE = {"duration_ms", "last_seen", "ts", "updated_at", "now", "uptime", "elapsed_ms", "generated_at"}

# (cli_namespace, gateway_namespace, tool, args) — read-only, low-volatility tools
CASES = [
    # no-required-field tools: {} is schema-valid on both sides
    ("agent", "agent", "project_list", {}),
    ("agent", "agent", "note_list", {}),
    ("agent", "agent", "agent_list", {}),
    ("agent", "agent", "dashboard_list", {}),
    ("engine", "engine-bridge", "git_status", {}),
    ("engine", "engine-bridge", "list_projects", {}),
    # arg-passing parity (engine, real file path)
    ("engine", "engine-bridge", "file_outline", {"path": "/home/damienldx/workspace/ubik-mcp/package.json"}),
]

_sid = None
def gw(method, params=None):
    global _sid
    body = {"jsonrpc": "2.0", "id": 1, "method": method}
    if params is not None: body["params"] = params
    req = urllib.request.Request(GW, data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                 **({"Mcp-Session-Id": _sid} if _sid else {})})
    r = urllib.request.urlopen(req, timeout=60)
    if not _sid: _sid = r.headers.get("Mcp-Session-Id")
    raw = r.read().decode(); pl = None
    if "data:" in raw[:80]:
        for ln in raw.splitlines():
            if ln.startswith("data:"): pl = json.loads(ln[5:].strip()); break
    else: pl = json.loads(raw)
    return pl

def strip(o):
    if isinstance(o, dict): return {k: strip(v) for k, v in o.items() if k not in VOLATILE}
    if isinstance(o, list): return [strip(x) for x in o]
    return o

def as_obj(text):
    try: return strip(json.loads(text))
    except (json.JSONDecodeError, TypeError): return text.strip() if isinstance(text, str) else text

gw("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "p", "version": "1"}})
try: gw("notifications/initialized", {})
except Exception: pass

passed = failed = 0
for cli_ns, gw_ns, tool, args in CASES:
    cli = subprocess.run([U, cli_ns, tool, "--args", json.dumps(args)], capture_output=True, text=True)
    cli_obj = as_obj(cli.stdout)
    res = gw("tools/call", {"name": f"{gw_ns}.{tool}", "arguments": args})
    text = res.get("result", {}).get("content", [{}])[0].get("text", "")
    gw_obj = as_obj(text)
    ok = (cli.returncode == 0) and (cli_obj == gw_obj)
    if ok:
        passed += 1; print(f"  PASS  {cli_ns}.{tool}")
    else:
        failed += 1
        print(f"  FAIL  {cli_ns}.{tool}  rc={cli.returncode}")
        print(f"        CLI: {json.dumps(cli_obj)[:160]}")
        print(f"        GW : {json.dumps(gw_obj)[:160]}")
        if cli.stderr: print(f"        err: {cli.stderr[:120]}")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
