#!/usr/bin/env node
/**
 * GPS Fleet — standalone MCP stdio server.
 *
 * One tool: `gps_lookup`. Given an agent message text, returns the best
 * matching persona (system_prompt) plus the top recommended MCP tools.
 *
 * Internally calls the existing `skills_recall` and `skills_search_tools`
 * gateway endpoints, composes a typed result, and caches by
 * (message_hash, agent_id, top_k) for 5 minutes — so re-reading the same
 * message N times costs one upstream lookup, not N.
 *
 * Imports: @modelcontextprotocol/sdk, zod, dotenv, node:* only.
 *
 * Env:
 *   UBIK_MCP_GATEWAY_URL  default http://127.0.0.1:7892
 *   GPS_CACHE_TTL_MS      default 300_000  (5 minutes)
 *   GPS_CACHE_MAX_ENTRIES default 256
 */

import { z } from "zod";
import { config } from "dotenv";
import path from "node:path";
import { createHash } from "node:crypto";
import { createMcpServer, runServer } from "../lib/server";

config({ path: path.join(process.cwd(), ".env") });

// ── Config ───────────────────────────────────────────────────────────────────
const GATEWAY_URL = process.env.UBIK_MCP_GATEWAY_URL ?? "http://127.0.0.1:7892";
const CACHE_TTL_MS = Number(process.env.GPS_CACHE_TTL_MS ?? 300_000);
const CACHE_MAX = Number(process.env.GPS_CACHE_MAX_ENTRIES ?? 256);
const HTTP_TIMEOUT_MS = 10_000;

// ── Tiny LRU cache ───────────────────────────────────────────────────────────
type CacheEntry<T> = { value: T; expiresAt: number };
const cache = new Map<string, CacheEntry<unknown>>();

function cacheGet<T>(key: string): T | null {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  // refresh recency (LRU)
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function cacheSet<T>(key: string, value: T): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function cacheKey(parts: Array<string | number>): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(String(p)).update("\0");
  return h.digest("hex").slice(0, 24);
}

// ── HTTP helper with abort ───────────────────────────────────────────────────
async function gatewayCall(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${GATEWAY_URL}/tools/${encodeURIComponent(toolName)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ arguments: args }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: await res.text() };
    }
    const text = await res.text();
    if (!text) return { ok: true };
    try {
      return JSON.parse(text);
    } catch {
      return { ok: true, raw: text };
    }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(t);
  }
}

// ── Result composition ───────────────────────────────────────────────────────
type Persona = {
  id: string;
  name: string;
  system_prompt: string;
  confidence: number;
} | null;

type RecommendedTool = {
  name: string;
  server: string;
  score: number;
};

type GpsResult = {
  persona: Persona;
  recommended_tools: RecommendedTool[];
  cache_key: string;
  cached: boolean;
};

function pickFirstSkill(raw: unknown): Persona {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const items = (r.results ?? r.skills ?? []) as Array<Record<string, unknown>>;
  if (!Array.isArray(items) || items.length === 0) return null;
  const top = items[0];
  const id = String(top.id ?? top.key ?? "unknown");
  const name = String(top.name ?? top.title ?? id);
  const sysPrompt = String(top.system_prompt ?? top.systemPrompt ?? top.content ?? "");
  const score = Number(top.score ?? top.similarity ?? 0);
  return { id, name, system_prompt: sysPrompt, confidence: score };
}

function pickTools(raw: unknown, topK: number): RecommendedTool[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as Record<string, unknown>;
  const items = (r.results ?? r.tools ?? []) as Array<Record<string, unknown>>;
  if (!Array.isArray(items)) return [];
  return items.slice(0, topK).map((t) => ({
    name: String(t.name ?? t.tool ?? "?"),
    server: String(t.server ?? t.server_id ?? "?"),
    score: Number(t.score ?? t.similarity ?? 0),
  }));
}

// ── Skip rules ───────────────────────────────────────────────────────────────
// Heuristics to decide whether a message is GPS-worthy. Returns the reason
// when skipping, or null when the message should be enriched. Order matters:
// cheaper checks first.

const ACK_PREFIXES = [
  "ack", "ok ", "ok.", "ok,", "ok !", "ok !",
  "noté", "note ", "merci", "thanks",
  "[ack]", "[result]", "[livré]", "[done]",
];
const ACK_TOKENS = new Set([
  "ok", "ack", "noté", "merci", "thanks", "ty", "👍", "✅", "🤝", "🙌", "+1",
]);
const ACK_LEAD_EMOJI = /^[\p{Extended_Pictographic}\s\p{P}]{1,12}/u;
const PR_OR_COMMIT_TAIL = /(https?:\/\/github\.com\/[^\s]+|commit\s+[a-f0-9]{7,40}|PR\s*#\d+)$/i;
const QUOTE_PREFIX = /^(re:|>|\[bridge\])/i;
const MECA_SUFFIX = /-meca\b|^bridge:/i;

function shouldSkip(opts: {
  message: string;
  from?: string;
  to?: string;
  min_chars?: number;
}): { skip: boolean; reason: string | null } {
  const msg = (opts.message || "").trim();
  const from = (opts.from || "").trim();
  const to = (opts.to || "").trim();
  const minChars = opts.min_chars ?? 80;

  // Rule 1 — sender or recipient is a meca / bridge → skip.
  if (MECA_SUFFIX.test(from)) return { skip: true, reason: `sender_is_meca:${from}` };
  if (MECA_SUFFIX.test(to)) return { skip: true, reason: `recipient_is_meca:${to}` };

  // Rule 2 — empty or trivially short message.
  if (!msg) return { skip: true, reason: "empty_message" };
  if (msg.length < minChars) return { skip: true, reason: `short_message:${msg.length}<${minChars}` };

  // Rule 3 — quotation / forward / bridge prefix.
  if (QUOTE_PREFIX.test(msg)) return { skip: true, reason: "quote_or_bridge_prefix" };

  // Rule 4 — single-token ack.
  const lower = msg.toLowerCase();
  if (ACK_TOKENS.has(lower)) return { skip: true, reason: `single_ack_token:${lower}` };

  // Rule 5 — known ack prefixes (case-insensitive, after optional emoji lead).
  const stripped = lower.replace(ACK_LEAD_EMOJI, "").trimStart();
  for (const p of ACK_PREFIXES) {
    if (stripped.startsWith(p)) {
      return { skip: true, reason: `ack_prefix:${p.trim()}` };
    }
  }

  // Rule 6 — PR / commit / GitHub URL trailing : likely a delivery report.
  if (PR_OR_COMMIT_TAIL.test(msg)) {
    return { skip: true, reason: "delivery_report_tail" };
  }

  // Rule 7 — emoji-heavy social reaction (>30% of chars are emoji).
  const emojiCount = (msg.match(/\p{Extended_Pictographic}/gu) || []).length;
  if (emojiCount > 0 && emojiCount * 3 > msg.length) {
    return { skip: true, reason: `emoji_heavy:${emojiCount}/${msg.length}` };
  }

  // Rule 8 — almost-only digits / JSON.
  const alphaCount = (msg.match(/\p{L}/gu) || []).length;
  if (alphaCount * 4 < msg.length) {
    return { skip: true, reason: `alpha_sparse:${alphaCount}/${msg.length}` };
  }

  return { skip: false, reason: null };
}

// ── Server ───────────────────────────────────────────────────────────────────
const server = createMcpServer("ubik-gps", "0.1.0");

server.tool(
  "gps_should_enrich",
  "Returns whether a message warrants a full GPS lookup, with the skip reason when not. Cheap (regex + length checks), call this first to avoid paying the upstream lookup on acks, deliveries, bridge forwards, single-emoji reactions, etc.",
  {
    message: z.string().describe("The message text to evaluate."),
    from: z.string().optional().describe("Sender id (used to skip when source is a meca/bridge)."),
    to: z.string().optional().describe("Recipient id (used to skip when destination is a meca/bridge)."),
    min_chars: z.number().int().min(0).max(2000).default(80).describe("Below this length the message is considered too short for GPS (default 80)."),
  },
  async (args) => {
    const verdict = shouldSkip(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(verdict, null, 2) }] };
  },
);

server.tool(
  "gps_lookup",
  "Returns the best matching persona (system_prompt) and top recommended MCP tools for the given message text. Cacheable: re-calling with the same message + agent_id + top_k returns cached result for up to 5 minutes (LRU 256 entries). Use this AT THE START of a mission rather than on every relay_read.",
  {
    message: z
      .string()
      .min(1)
      .describe("The agent message or mission brief to interpret. Used as both persona retrieval and tool ranking input."),
    agent_id: z
      .string()
      .optional()
      .describe("Optional agent identifier — included in the cache key so two agents reading the same broadcast can get distinct recommendations."),
    top_k: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(6)
      .describe("How many recommended tools to return (default 6)."),
  },
  async ({ message, agent_id, top_k }) => {
    const key = cacheKey([message, agent_id ?? "", top_k]);
    const cached = cacheGet<GpsResult>(key);
    if (cached) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ...cached, cached: true }, null, 2) }],
      };
    }

    const [skillsRaw, toolsRaw] = await Promise.all([
      gatewayCall("skills_recall", { query: message, top_k: 1 }),
      gatewayCall("skills_search_tools", { query: message, top_k }),
    ]);

    const result: GpsResult = {
      persona: pickFirstSkill(skillsRaw),
      recommended_tools: pickTools(toolsRaw, top_k),
      cache_key: key,
      cached: false,
    };

    cacheSet(key, { ...result, cached: false });

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.tool(
  "gps_invalidate",
  "Invalidates one cached GPS lookup by cache_key (returned in `gps_lookup` results), or the whole cache when key is omitted.",
  {
    cache_key: z
      .string()
      .optional()
      .describe("Cache key from a previous gps_lookup. Omit to flush the whole LRU."),
  },
  async ({ cache_key }) => {
    if (!cache_key) {
      const n = cache.size;
      cache.clear();
      return { content: [{ type: "text" as const, text: `flushed ${n} entries` }] };
    }
    const found = cache.delete(cache_key);
    return {
      content: [
        { type: "text" as const, text: found ? `evicted ${cache_key}` : `not found: ${cache_key}` },
      ],
    };
  },
);

server.tool(
  "gps_stats",
  "Returns cache stats (entry count, TTL, max size) for observability.",
  {},
  async () => {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              entries: cache.size,
              max_entries: CACHE_MAX,
              ttl_ms: CACHE_TTL_MS,
              gateway_url: GATEWAY_URL,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

runServer(server).catch((err) => {
  process.stderr.write(`[ubik-gps] fatal: ${String(err)}\n`);
  process.exit(1);
});
