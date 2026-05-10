#!/usr/bin/env node
/**
 * GPS Fleet — standalone MCP stdio server.
 *
 * Two layers:
 *   1. Per-message recommendation (`gps_lookup` + `gps_should_enrich`) —
 *      embedding match on a single message text, returns a top-1 persona
 *      and top-K recommended tools, cached for 5 minutes.
 *   2. Per-fork contract (`gps_lock` + `gps_relock` + `gps_get_contract` +
 *      `gps_unlock`) — a persona + tools allowlist signed at fork entry,
 *      persisted on disk for the duration of the mission. Once a contract
 *      is active for an agent, per-message lookups short-circuit to the
 *      contract value (cheap, stable, accountable) instead of re-rolling
 *      a fresh persona on every message.
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
 *   UBIK_MEMORY_DIR       default ~/.ubik-memory
 */

import { z } from "zod";
import { config } from "dotenv";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import { createMcpServer, runServer } from "../lib/server";

config({ path: path.join(process.cwd(), ".env") });

// ── Config ───────────────────────────────────────────────────────────────────
const GATEWAY_URL = process.env.UBIK_MCP_GATEWAY_URL ?? "http://127.0.0.1:7892";
const CACHE_TTL_MS = Number(process.env.GPS_CACHE_TTL_MS ?? 300_000);
const CACHE_MAX = Number(process.env.GPS_CACHE_MAX_ENTRIES ?? 256);
const HTTP_TIMEOUT_MS = 10_000;

const MEMORY_DIR = process.env.UBIK_MEMORY_DIR ?? path.join(os.homedir(), ".ubik-memory");
const FORKS_DIR  = path.join(MEMORY_DIR, "forks");

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

type AgentTraining = {
  hint: string;
  tools: ["agent_search", "agent_train"];
};

// GpsResult is the per-message lookup output. The first 4 fields are the
// stable contract any caller has always seen. New fields are optional, both
// to preserve back-compat with existing consumers and because they only make
// sense when a fork contract is active.
type GpsResult = {
  persona: Persona;
  recommended_tools: RecommendedTool[];
  agent_training: AgentTraining;
  cached: boolean;
  cache_key?: string | null;
  from_contract?: boolean;
  fork_id?: string;
  signed_at?: string;
};

const AGENT_TRAINING: AgentTraining = {
  hint: "Call agent_search(mission) for a ranked shortlist of specialist agents, then agent_train(id) to inject the chosen manifest as your operating identity.",
  tools: ["agent_search", "agent_train"],
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

async function computeLookup(message: string, topK: number): Promise<{
  persona: Persona;
  recommended_tools: RecommendedTool[];
}> {
  const [skillsRaw, toolsRaw] = await Promise.all([
    gatewayCall("skills_recall", { query: message, top_k: 1 }),
    gatewayCall("skills_search_tools", { query: message, top_k: topK }),
  ]);
  return {
    persona: pickFirstSkill(skillsRaw),
    recommended_tools: pickTools(toolsRaw, topK),
  };
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

function shouldSkipText(opts: {
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

// ── Fork contract — disk-backed persona/tools allowlist for a mission ───────
//
// A contract pins an agent's persona for the duration of a fork. While a
// contract is active, per-message lookups short-circuit to the contract value
// instead of re-embedding the message — so the agent has a stable identity
// across the mission and the gateway pays one embedding cost, not N.
//
// Layout: `${MEMORY_DIR}/forks/<fork_id>/gps_contract.json`. We never assume
// only one contract per agent — an agent can be active on multiple forks
// (rare in practice). `findActiveContractByAgent` returns the most-recently
// signed one, which matches the natural "current mission" semantics.

type GpsContract = {
  fork_id: string;
  agent_id: string;
  persona: Persona;
  recommended_tools: RecommendedTool[];
  tools_allowlist: string[];
  mission_brief: string;
  budget_hint: string | null;
  signed_at: string;
};

function contractPath(forkId: string): string {
  return path.join(FORKS_DIR, forkId, "gps_contract.json");
}

async function readContract(forkId: string): Promise<GpsContract | null> {
  try {
    const raw = await fsp.readFile(contractPath(forkId), "utf8");
    return JSON.parse(raw) as GpsContract;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    return null;
  }
}

async function writeContract(contract: GpsContract): Promise<void> {
  const dir = path.dirname(contractPath(contract.fork_id));
  await fsp.mkdir(dir, { recursive: true });
  // Write via tempfile + rename so concurrent readers never see a torn file.
  const tmp = contractPath(contract.fork_id) + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(contract, null, 2), "utf8");
  await fsp.rename(tmp, contractPath(contract.fork_id));
}

async function deleteContract(forkId: string): Promise<boolean> {
  try {
    await fsp.rm(contractPath(forkId));
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw err;
  }
}

async function findActiveContractByAgent(agentId: string): Promise<GpsContract | null> {
  let forks: import("node:fs").Dirent[];
  try {
    forks = await fsp.readdir(FORKS_DIR, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
  // Read contracts in parallel — N is small (tens of forks max), and each
  // file is < 1kB. Sequential await would serialize disk seeks for no benefit.
  const dirs = forks.filter((e) => e.isDirectory()).map((e) => e.name);
  const contracts = await Promise.all(dirs.map((d) => readContract(d)));
  let best: GpsContract | null = null;
  for (const c of contracts) {
    if (!c || c.agent_id !== agentId) continue;
    if (!best || c.signed_at > best.signed_at) best = c;
  }
  return best;
}

async function countActiveContracts(): Promise<number> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(FORKS_DIR, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
    throw err;
  }
  const checks = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map((e) => fsp.access(contractPath(e.name)).then(() => true, () => false)),
  );
  return checks.filter(Boolean).length;
}

// ── Server ───────────────────────────────────────────────────────────────────
const server = createMcpServer("ubik-gps", "0.2.0");

server.tool(
  "gps_should_enrich",
  "Returns whether a message warrants a full GPS lookup, with the skip reason when not. Cheap (regex + length checks), call this first to avoid paying the upstream lookup on acks, deliveries, bridge forwards, single-emoji reactions, etc. When `agent_id` is provided and that agent has an active fork contract, returns skip:true reason='fork_contract_active' — the caller should use the contract instead of re-rolling.",
  {
    message: z.string().describe("The message text to evaluate."),
    from: z.string().optional().describe("Sender id (used to skip when source is a meca/bridge)."),
    to: z.string().optional().describe("Recipient id (used to skip when destination is a meca/bridge)."),
    min_chars: z.number().int().min(0).max(2000).default(80).describe("Below this length the message is considered too short for GPS (default 80)."),
    agent_id: z.string().optional().describe("Optional agent id. When set, an active fork contract for this agent short-circuits enrichment (skip:true with reason='fork_contract_active')."),
  },
  async (args) => {
    const verdict = shouldSkipText(args);
    if (!verdict.skip && args.agent_id) {
      const active = await findActiveContractByAgent(args.agent_id);
      if (active) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              skip: true,
              reason: "fork_contract_active",
              fork_id: active.fork_id,
              persona_id: active.persona?.id ?? null,
              signed_at: active.signed_at,
            }, null, 2),
          }],
        };
      }
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(verdict, null, 2) }] };
  },
);

server.tool(
  "gps_lookup",
  "Returns the best matching persona (system_prompt) and top recommended MCP tools for the given message text. Cacheable: re-calling with the same message + agent_id + top_k returns cached result for up to 5 minutes (LRU 256 entries). When `fork_id` is provided and a contract exists for it, returns the contract's persona + tools (with `from_contract: true`) — no embedding cost. Use this AT THE START of a mission rather than on every relay_read; for the duration of the mission, prefer `gps_lock` once + read the contract.",
  {
    message: z
      .string()
      .min(1)
      .describe("The agent message or mission brief to interpret. Used as both persona retrieval and tool ranking input."),
    agent_id: z
      .string()
      .optional()
      .describe("Optional agent identifier — included in the cache key so two agents reading the same broadcast can get distinct recommendations."),
    fork_id: z
      .string()
      .optional()
      .describe("Optional fork id. If a gps_contract.json exists for this fork, lookup short-circuits to its persona/tools (saves embedding + ranking cost)."),
    top_k: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(6)
      .describe("How many recommended tools to return (default 6)."),
  },
  async ({ message, agent_id, fork_id, top_k }) => {
    if (fork_id) {
      const contract = await readContract(fork_id);
      if (contract) {
        const result: GpsResult = {
          persona: contract.persona,
          recommended_tools: contract.recommended_tools,
          agent_training: AGENT_TRAINING,
          cached: false,
          cache_key: null,
          from_contract: true,
          fork_id,
          signed_at: contract.signed_at,
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
    }

    const key = cacheKey([message, agent_id ?? "", top_k]);
    const cached = cacheGet<GpsResult>(key);
    if (cached) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ...cached, cached: true }, null, 2) }],
      };
    }

    const { persona, recommended_tools } = await computeLookup(message, top_k);
    const result: GpsResult = {
      persona,
      recommended_tools,
      agent_training: AGENT_TRAINING,
      cached: false,
      cache_key: key,
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
  "Returns cache stats (entry count, TTL, max size) for observability. Also reports the count of active fork contracts on disk.",
  {},
  async () => {
    const activeContracts = await countActiveContracts();
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
              active_fork_contracts: activeContracts,
              memory_dir: MEMORY_DIR,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ── Fork contract tools ──────────────────────────────────────────────────────

server.tool(
  "gps_lock",
  "Sign a GPS contract for a fork — runs gps_lookup once on the mission brief, persists the persona + recommended tools as the agent's identity for the duration of the fork. While the contract exists, `gps_lookup({fork_id})` short-circuits to it and `gps_should_enrich({agent_id})` returns skip:true reason='fork_contract_active'. Idempotent if called twice with the same brief; use `gps_relock` to override with a different brief.",
  {
    fork_id: z.string().min(1).describe("Fork identifier (e.g. project_fork_register output). Becomes the directory name under ~/.ubik-memory/forks/."),
    agent_id: z.string().min(1).describe("Agent assigned to this fork. Recorded in the contract for `findActiveContractByAgent` lookup."),
    mission_brief: z.string().min(1).describe("Free-form mission description. Used as the embedding input for persona + tool ranking."),
    top_k: z.number().int().min(1).max(20).default(6).describe("How many recommended tools to capture in the allowlist (default 6)."),
    budget_hint: z.string().optional().describe("Free-form budget hint for the merger / human (e.g. 'low — read-only review', 'high — schema migration')."),
    tools_allowlist: z.array(z.string()).optional().describe("Override the derived allowlist. When omitted, uses recommended_tools.map(t => t.name)."),
  },
  async ({ fork_id, agent_id, mission_brief, top_k, budget_hint, tools_allowlist }) => {
    const existing = await readContract(fork_id);
    if (existing && existing.mission_brief === mission_brief && existing.agent_id === agent_id) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ...existing, idempotent: true }, null, 2),
        }],
      };
    }

    const { persona, recommended_tools } = await computeLookup(mission_brief, top_k);
    const allowlist = tools_allowlist ?? recommended_tools.map((t) => t.name);
    const contract: GpsContract = {
      fork_id,
      agent_id,
      persona,
      recommended_tools,
      tools_allowlist: allowlist,
      mission_brief,
      budget_hint: budget_hint ?? null,
      signed_at: new Date().toISOString(),
    };
    await writeContract(contract);
    return { content: [{ type: "text" as const, text: JSON.stringify(contract, null, 2) }] };
  },
);

server.tool(
  "gps_relock",
  "Replace an existing fork contract with a new one — re-runs gps_lookup on the new brief. Use when the mission pivots in scope and the old persona is no longer the right fit. Errors if no contract exists; call `gps_lock` for the first signature.",
  {
    fork_id: z.string().min(1).describe("Fork identifier whose contract is being replaced."),
    new_mission_brief: z.string().min(1).describe("Fresh mission brief used to compute the new persona + tool ranking."),
    top_k: z.number().int().min(1).max(20).default(6).describe("How many recommended tools to capture (default 6)."),
    budget_hint: z.string().optional().describe("Optional new budget hint. Defaults to the previous contract's budget_hint."),
    tools_allowlist: z.array(z.string()).optional().describe("Override the derived allowlist."),
  },
  async ({ fork_id, new_mission_brief, top_k, budget_hint, tools_allowlist }) => {
    const existing = await readContract(fork_id);
    if (!existing) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ error: `no contract for fork_id=${fork_id} — call gps_lock first` }, null, 2),
        }],
        isError: true,
      };
    }
    const { persona, recommended_tools } = await computeLookup(new_mission_brief, top_k);
    const allowlist = tools_allowlist ?? recommended_tools.map((t) => t.name);
    const contract: GpsContract = {
      ...existing,
      persona,
      recommended_tools,
      tools_allowlist: allowlist,
      mission_brief: new_mission_brief,
      budget_hint: budget_hint ?? existing.budget_hint,
      signed_at: new Date().toISOString(),
    };
    await writeContract(contract);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ ...contract, previous_persona_id: existing.persona?.id ?? null }, null, 2),
      }],
    };
  },
);

server.tool(
  "gps_get_contract",
  "Read a fork contract — by fork_id (preferred) or by agent_id (returns the most-recently-signed contract for that agent). Returns null inside the JSON when no contract is found, never errors.",
  {
    fork_id: z.string().optional().describe("Fork identifier. Mutually exclusive with agent_id; if both are given, fork_id wins."),
    agent_id: z.string().optional().describe("Agent identifier. Returns the most-recently-signed contract for this agent across all forks."),
  },
  async ({ fork_id, agent_id }) => {
    if (!fork_id && !agent_id) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "provide fork_id or agent_id" }) }],
        isError: true,
      };
    }
    const contract = fork_id
      ? await readContract(fork_id)
      : await findActiveContractByAgent(agent_id!);
    return { content: [{ type: "text" as const, text: JSON.stringify(contract, null, 2) }] };
  },
);

server.tool(
  "gps_unlock",
  "Delete a fork contract. Use when the fork closes — the agent reverts to per-message GPS lookups for any future messages. No-op if the contract doesn't exist.",
  {
    fork_id: z.string().min(1).describe("Fork identifier whose contract is being released."),
  },
  async ({ fork_id }) => {
    const existed = await deleteContract(fork_id);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ fork_id, deleted: existed }, null, 2),
      }],
    };
  },
);

runServer(server).catch((err) => {
  process.stderr.write(`[ubik-gps] fatal: ${String(err)}\n`);
  process.exit(1);
});
