/**
 * MCP Auth — Secure per-request tenant isolation for MCP servers
 *
 * Fixes three critical multi-tenant security issues:
 * 1. HMAC-signed requests prevent userId spoofing (derived per-server key)
 * 2. Per-server key derivation from a single INTERNAL_API_SECRET
 * 3. AsyncLocalStorage prevents race conditions on concurrent tool calls
 *
 * Usage in MCP servers:
 *   import { createMcpAuth } from "../../lib/mcp-auth";
 *   const auth = createMcpAuth("ubik-google");
 *   // In transport.onmessage interceptor:
 *   auth.runWithUserId(userId, () => sdkHandler(msg));
 *   // In tool handlers:
 *   const userId = auth.getUserId();
 *   const token = await auth.fetchToken("gmail");
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, timingSafeEqual } from "node:crypto";

// ─── AsyncLocalStorage for request-scoped userId ───

const userIdStore = new AsyncLocalStorage<string>();

// ─── HMAC signing ───

/**
 * Derive a per-server HMAC key from the shared secret.
 * Each MCP server gets a unique key: HMAC-SHA256(INTERNAL_API_SECRET, serverName).
 * This way, a compromised server's key cannot be used to impersonate another server.
 */
function deriveServerKey(sharedSecret: string, serverName: string): Buffer {
  return createHmac("sha256", sharedSecret).update(serverName).digest();
}

/**
 * Sign a request payload: HMAC-SHA256(derivedKey, "userId:timestamp")
 * Timestamp prevents replay attacks (server validates within ±30s window).
 */
function signRequest(
  derivedKey: Buffer,
  userId: string,
  timestamp: number,
): string {
  const payload = `${userId}:${timestamp}`;
  return createHmac("sha256", derivedKey).update(payload).digest("hex");
}

/**
 * Verify an HMAC signature from an MCP server request.
 * Checks against a ±30s window to prevent replay attacks.
 */
export function verifyMcpSignature(
  sharedSecret: string,
  serverName: string,
  userId: string,
  timestamp: number,
  signature: string,
): boolean {
  const now = Date.now();
  const drift = Math.abs(now - timestamp);
  if (drift > 30_000) return false; // reject requests older than 30s

  const derivedKey = deriveServerKey(sharedSecret, serverName);
  const expected = signRequest(derivedKey, userId, timestamp);

  // Timing-safe comparison
  const sigBuf = Buffer.from(signature, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf, expBuf);
}

// ─── MCP Auth instance (one per server) ───

export interface McpAuth {
  /** Run a function with a request-scoped userId (AsyncLocalStorage) */
  runWithUserId: <T>(userId: string, fn: () => T) => T;
  /** Get the current request's userId (throws if called outside runWithUserId) */
  getUserId: () => string;
  /** Fetch a connector token from UBIK API with HMAC-signed auth */
  fetchToken: (service: string, provider?: string) => Promise<string>;
  /** Get auth headers for a request to the UBIK API */
  getAuthHeaders: () => Record<string, string>;
  /** The server name */
  serverName: string;
}

export function createMcpAuth(serverName: string): McpAuth {
  const sharedSecret = process.env.INTERNAL_API_SECRET;
  if (!sharedSecret) {
    console.error(`[mcp-auth] CRITICAL: INTERNAL_API_SECRET not configured for ${serverName}`);
    process.exit(1);
  }

  const derivedKey = deriveServerKey(sharedSecret, serverName);
  const ubikApi =
    process.env.UBIK_API_URL || process.env.UBIK_BASE_URL || "http://localhost:3001";
  const defaultUserId = process.env.UBIK_USER_ID || process.env.UBIK_DEFAULT_USER_ID || "";

  function getUserId(): string {
    const uid = userIdStore.getStore();
    if (uid) return uid;
    if (defaultUserId) return defaultUserId;
    throw new Error(`[mcp-auth:${serverName}] No userId in request context and no default configured`);
  }

  function getAuthHeaders(): Record<string, string> {
    const userId = getUserId();
    const timestamp = Date.now();
    const signature = signRequest(derivedKey, userId, timestamp);
    return {
      "X-UBIK-MCP": serverName,
      "X-UBIK-USER-ID": userId,
      "X-UBIK-MCP-TIMESTAMP": String(timestamp),
      "X-UBIK-MCP-SIGNATURE": signature,
    };
  }

  async function fetchToken(service: string, provider = "google"): Promise<string> {
    const res = await fetch(
      `${ubikApi}/api/connectors/token?service=${service}&provider=${provider}`,
      { headers: getAuthHeaders() },
    );
    if (!res.ok) {
      throw new Error(`No valid token for ${provider}-${service} — connect it in UBIK Connectors panel`);
    }
    const data = await res.json();
    return data.token;
  }

  return {
    runWithUserId: <T>(userId: string, fn: () => T): T => {
      return userIdStore.run(userId, fn);
    },
    getUserId,
    fetchToken,
    getAuthHeaders,
    serverName,
  };
}

/**
 * Intercept MCP JSON-RPC messages to extract _ubikUserId and run
 * the handler inside AsyncLocalStorage context.
 *
 * Drop-in replacement for the old global-variable pattern.
 * Call this once after transport.connect():
 *
 *   wrapTransportWithAuth(transport, auth);
 */
export function wrapTransportWithAuth(
  transport: { onmessage?: (msg: any) => any },
  auth: McpAuth,
): void {
  const originalHandler = transport.onmessage;
  transport.onmessage = (msg: any) => {
    if (!originalHandler) return;

    // Extract userId from tool call arguments
    let userId: string | undefined;
    if (msg?.method === "tools/call" && msg?.params?.arguments?._ubikUserId) {
      userId = msg.params.arguments._ubikUserId;
      delete msg.params.arguments._ubikUserId; // Remove before Zod validation
    }

    if (userId) {
      return auth.runWithUserId(userId, () => originalHandler(msg));
    }
    return originalHandler(msg);
  };
}
