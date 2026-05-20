#!/usr/bin/env python3
"""
UBIK MCP local proxy — expose backend tools (localhost:8765) via stdio MCP.
No SSH tunnel needed: backend is local on dev-station-02.
"""
import sys, json, os, urllib.request as req, urllib.error as uerr

BASE = os.environ.get("UBIK_BACKEND", "http://127.0.0.1:8765")
TOKEN = ""
try:
    cfg = json.load(open(os.path.expanduser("~/.ubik-agent/config.json")))
    TOKEN = cfg.get("token", "")
except Exception:
    pass

# No tools cache: discover is cheap on localhost and stale cache hid
# newly added tools after a backend reload.

def _headers():
    h = {"Content-Type": "application/json", "x-ubik-agent-token": TOKEN}
    # Propagate caller identity so backend lead-only guards can authorize.
    caller = os.environ.get("UBIK_AGENT_ID", "")
    if caller:
        h["x-ubik-caller-agent-id"] = caller
    return h

def _get(path):
    r = req.Request(f"{BASE}{path}", headers=_headers())
    try:
        with req.urlopen(r, timeout=10) as resp:
            return json.loads(resp.read())
    except uerr.URLError as e:
        raise RuntimeError(
            f"UBIK backend unreachable at {BASE} ({e.reason}). "
            f"Check: systemctl --user status ubik-backend"
        ) from e

def _post(path, body):
    data = json.dumps(body).encode()
    r = req.Request(f"{BASE}{path}", data=data, headers=_headers(), method="POST")
    try:
        with req.urlopen(r, timeout=60) as resp:
            return json.loads(resp.read())
    except uerr.URLError as e:
        raise RuntimeError(
            f"UBIK backend unreachable at {BASE} ({e.reason}). "
            f"Check: systemctl --user status ubik-backend"
        ) from e

def list_tools():
    data = _get("/api/tools/discover")
    return data.get("tools", [])

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def handle(msg):
    method = msg.get("method", "")
    mid = msg.get("id")
    params = msg.get("params") or {}

    if method == "initialize":
        send({"jsonrpc":"2.0","id":mid,"result":{
            "protocolVersion":"2024-11-05",
            "capabilities":{"tools":{"listChanged":False}},
            "serverInfo":{"name":"ubik-local","version":"1.0.0"}
        }})

    elif method == "notifications/initialized":
        pass

    elif method == "tools/list":
        tools = list_tools()
        mcp_tools = []
        for t in tools:
            schema = t.get("inputSchema") or {"type":"object","properties":{},"required":[]}
            mcp_tools.append({"name":t["name"],"description":t.get("description",""),"inputSchema":schema})
        send({"jsonrpc":"2.0","id":mid,"result":{"tools":mcp_tools}})

    elif method == "tools/call":
        name = params.get("name","")
        args = params.get("arguments") or {}
        try:
            result = _post("/api/tools/execute", {"tool": name, "input": args})
            content = json.dumps(result.get("result", result), ensure_ascii=False)
            send({"jsonrpc":"2.0","id":mid,"result":{"content":[{"type":"text","text":content}],"isError":False}})
        except uerr.HTTPError as e:
            send({"jsonrpc":"2.0","id":mid,"result":{"content":[{"type":"text","text":f"HTTP {e.code}"}],"isError":True}})
        except Exception as e:
            send({"jsonrpc":"2.0","id":mid,"result":{"content":[{"type":"text","text":str(e)}],"isError":True}})

    elif mid is not None:
        send({"jsonrpc":"2.0","id":mid,"error":{"code":-32601,"message":f"Method not found: {method}"}})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        handle(json.loads(line))
    except Exception as e:
        sys.stderr.write(f"[ubik-local] error: {e}\n")
