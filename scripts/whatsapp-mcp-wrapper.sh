#!/bin/bash
# Wrapper for WhatsApp MCP server — resolves per-user bridge port
# Called by Claude Code / Gemini CLI / Codex CLI via .mcp.json
#
# IMPORTANT: We do NOT start the Go bridge here. The MCP Python server
# manages the bridge lifecycle (start/stop/QR capture via stdout).
# We only resolve which port to use.

UBIK_API="http://localhost:${PORT:-3001}"
USER_ID="${UBIK_USER_ID:-}"

# If Node.js already set WHATSAPP_BRIDGE_URL (via ensureBridge), trust it
if [ -z "$WHATSAPP_BRIDGE_URL" ]; then
  if [ -n "$USER_ID" ]; then
    # Ask UBIK for the allocated port (GET only — do NOT start the bridge)
    BRIDGE_INFO=$(curl -s "${UBIK_API}/api/whatsapp/bridge?userId=${USER_ID}" 2>/dev/null)
    BRIDGE_URL=$(echo "$BRIDGE_INFO" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('bridge',{}).get('url',''))" 2>/dev/null)

    if [ -n "$BRIDGE_URL" ] && [ "$BRIDGE_URL" != "None" ] && [ "$BRIDGE_URL" != "" ]; then
      export WHATSAPP_BRIDGE_URL="$BRIDGE_URL"
    else
      export WHATSAPP_BRIDGE_URL="http://localhost:8080"
    fi
  else
    export WHATSAPP_BRIDGE_URL="http://localhost:8080"
  fi
fi

# Also set the bridge CWD so the MCP server spawns the bridge in the right directory
if [ -n "$USER_ID" ]; then
  BRIDGE_DIR="/home/damienldx/workspace/UBIK/data/users/${USER_ID}/whatsapp"
  mkdir -p "${BRIDGE_DIR}/store"
  export WHATSAPP_BRIDGE_DIR="$BRIDGE_DIR"
fi

# Launch the actual MCP server
exec /home/damienldx/.local/bin/uv --directory /home/damienldx/workspace/whatsapp-mcp/whatsapp-mcp-server run main.py
