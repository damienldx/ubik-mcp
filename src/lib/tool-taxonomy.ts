/**
 * tool-taxonomy.ts — Taxonomic tagging of MCP tools for GPS v2.
 *
 * The legacy GPS pipeline ranks tools via semantic embedding on the message
 * text. That works for persona retrieval (intent → label) but is noisy for
 * tools (a backend-Python message gets ranked LinkedIn / Gmail / Drive tools
 * by lexical proximity, not by capability fit).
 *
 * GPS v2 splits the two pipelines:
 *   • Persona  — stays semantic (embedding on message text), locked at fork.
 *   • Toolkit  — taxonomic. Each tool is tagged on two axes (operation × domain).
 *                A mission expresses what it needs as a matrix, and the toolkit
 *                is assembled deterministically from the intersection.
 *
 * Two mechanisms layered on top of the deterministic match :
 *   • Agent manifest YAML — ~/.ubik-desktop/agents/<id>.yaml — opt-in / opt-out
 *     overrides per agent. Read at register-time.
 *   • Heuristic fallback — unknown tools are tagged from naming conventions
 *     (read/write/create/search/list/get prefixes).
 */

// ── Axes ─────────────────────────────────────────────────────────────────────

export const OPERATION_CLASSES = [
  "read",     // fetch / list / get / inspect, no side effect
  "write",    // create / update / patch / delete (mutation)
  "network",  // outbound HTTP / browser navigation
  "search",   // discovery / ranking / lookup over a corpus
  "social",   // human-channel messaging (email, chat, post)
  "spawn",    // launch processes / agents / sessions
  "review",   // code / artifact review (read-only with judgement)
] as const;

export const TARGET_DOMAINS = [
  "filesystem",  // local files, sqlite, indexed corpora
  "git",         // repos, commits, branches, PRs
  "http_api",    // arbitrary REST / GraphQL APIs
  "db",          // SQL / NoSQL stores
  "browser",     // headless browsing / screenshots / RPA
  "agent_relay", // fleet relay, agent registry, project module
] as const;

export type OperationClass = typeof OPERATION_CLASSES[number];
export type TargetDomain = typeof TARGET_DOMAINS[number];

export type ToolTag = {
  operation_classes: OperationClass[];
  target_domains: TargetDomain[];
};

export type MissionMatrix = {
  operations: OperationClass[];
  domains: TargetDomain[];
};

export type AgentManifest = {
  exclude_classes?: OperationClass[];
  exclude_domains?: TargetDomain[];
  exclude_tools?: string[];
  always_include?: string[];
};

// ── Static catalog — known UBIK MCP servers ──────────────────────────────────
//
// Each entry maps a tool prefix or full tool name to its (classes × domains)
// tagging. The most specific match wins (full name beats prefix).

type CatalogEntry = ToolTag & { match: "exact" | "prefix" };

const CATALOG: Record<string, CatalogEntry> = {
  // ── github.ts (git domain, full operation spread) ──
  "github_get_": { match: "prefix", operation_classes: ["read"],            target_domains: ["git"] },
  "github_list_": { match: "prefix", operation_classes: ["read", "search"], target_domains: ["git"] },
  "github_search_": { match: "prefix", operation_classes: ["search"],       target_domains: ["git"] },
  "github_create_": { match: "prefix", operation_classes: ["write"],        target_domains: ["git"] },
  "github_update_": { match: "prefix", operation_classes: ["write"],        target_domains: ["git"] },
  "github_merge_": { match: "prefix", operation_classes: ["write"],         target_domains: ["git"] },
  "github_": { match: "prefix", operation_classes: ["read"],                target_domains: ["git"] },

  // ── google.ts (gmail / drive / docs / sheets / search) ──
  "gmail_": { match: "prefix", operation_classes: ["social", "read"],            target_domains: ["http_api"] },
  "google_drive_": { match: "prefix", operation_classes: ["read", "write"],      target_domains: ["http_api", "filesystem"] },
  "google_docs_": { match: "prefix", operation_classes: ["read", "write"],       target_domains: ["http_api"] },
  "google_sheets_": { match: "prefix", operation_classes: ["read", "write"],     target_domains: ["http_api"] },
  "google_search": { match: "prefix", operation_classes: ["search"],             target_domains: ["http_api"] },

  // ── linkedin.ts (read-only social) ──
  "linkedin_create_": { match: "prefix", operation_classes: ["social", "write"], target_domains: ["http_api"] },
  "linkedin_": { match: "prefix", operation_classes: ["social", "read"],         target_domains: ["http_api"] },

  // ── microsoft.ts (outlook + drive — social + filesystem) ──
  "microsoft_reply_": { match: "prefix", operation_classes: ["social", "write"], target_domains: ["http_api"] },
  "microsoft_drive_": { match: "prefix", operation_classes: ["read", "write"],   target_domains: ["http_api", "filesystem"] },
  "microsoft_": { match: "prefix", operation_classes: ["social", "read"],        target_domains: ["http_api"] },

  // ── crawl.ts (web crawl / fetch) ──
  "crawl_submit_form": { match: "exact", operation_classes: ["write", "network"], target_domains: ["browser", "http_api"] },
  "crawl_": { match: "prefix", operation_classes: ["read", "network"],            target_domains: ["browser", "http_api"] },

  // ── review.ts (review-only on filesystem / git) ──
  "review_": { match: "prefix", operation_classes: ["review", "read"], target_domains: ["filesystem", "git"] },

  // ── formation.ts (RPA / desktop automation — write+spawn on browser) ──
  "formation_screenshot": { match: "exact", operation_classes: ["read"],            target_domains: ["browser"] },
  "formation_scroll": { match: "exact", operation_classes: ["write"],               target_domains: ["browser"] },
  "formation_": { match: "prefix", operation_classes: ["write", "spawn"],           target_domains: ["browser"] },

  // ── skills.ts (local SQLite + tool discovery) ──
  "skills_search_tools": { match: "exact", operation_classes: ["search"],         target_domains: ["filesystem", "agent_relay"] },
  "skills_query_": { match: "prefix", operation_classes: ["read", "search"],      target_domains: ["filesystem"] },
  "skills_outline_file": { match: "exact", operation_classes: ["read"],           target_domains: ["filesystem"] },
  "skills_save_context": { match: "exact", operation_classes: ["write"],          target_domains: ["filesystem"] },
  "skills_": { match: "prefix", operation_classes: ["read", "search"],            target_domains: ["filesystem"] },

  // ── system.ts ──
  "system_search_": { match: "prefix", operation_classes: ["search"],             target_domains: ["filesystem"] },
  "system_": { match: "prefix", operation_classes: ["read"],                      target_domains: ["filesystem", "agent_relay"] },

  // ── desktop.ts (fleet agents, sessions, projects, activity) ──
  "desktop_": { match: "prefix", operation_classes: ["read", "spawn"], target_domains: ["agent_relay"] },

  // ── gps.ts (self-introspection) ──
  "gps_": { match: "prefix", operation_classes: ["read", "search"], target_domains: ["agent_relay"] },

  // ── paperclip.ts (artefacts, write+spawn) ──
  "paperclip_": { match: "prefix", operation_classes: ["write", "spawn"], target_domains: ["agent_relay", "filesystem"] },

  // ── relay_*.* (fleet messaging) ──
  "relay_send": { match: "exact", operation_classes: ["social", "write"],     target_domains: ["agent_relay"] },
  "relay_react": { match: "exact", operation_classes: ["social", "write"],    target_domains: ["agent_relay"] },
  "relay_read": { match: "exact", operation_classes: ["read"],                target_domains: ["agent_relay"] },
  "relay_": { match: "prefix", operation_classes: ["read", "social"],          target_domains: ["agent_relay"] },

  // ── ubik_*.* (fleet management) ──
  "ubik_route_agent": { match: "exact", operation_classes: ["spawn"],          target_domains: ["agent_relay"] },
  "ubik_write": { match: "exact", operation_classes: ["write"],                target_domains: ["agent_relay"] },
  "ubik_": { match: "prefix", operation_classes: ["read", "spawn"],            target_domains: ["agent_relay"] },

  // ── agent_*.* (deeper fleet introspection) ──
  "agent_search": { match: "exact", operation_classes: ["search"],             target_domains: ["agent_relay"] },
  "agent_train": { match: "exact", operation_classes: ["write"],               target_domains: ["agent_relay"] },
  "agent_": { match: "prefix", operation_classes: ["read", "search"],          target_domains: ["agent_relay"] },

  // ── project_*.* (project module) ──
  "project_announce_": { match: "prefix", operation_classes: ["write", "social"], target_domains: ["agent_relay"] },
  "project_fork_": { match: "prefix", operation_classes: ["write"],                target_domains: ["agent_relay"] },
  "project_": { match: "prefix", operation_classes: ["read"],                      target_domains: ["agent_relay"] },

  // ── activity / inbox ──
  "activity_": { match: "prefix", operation_classes: ["read"], target_domains: ["agent_relay"] },
  "inbox_": { match: "prefix", operation_classes: ["read"],    target_domains: ["agent_relay"] },
};

// ── Heuristic fallback ───────────────────────────────────────────────────────

const HEURISTIC_OP: Array<{ test: RegExp; op: OperationClass }> = [
  { test: /(^|_)(get|list|fetch|read|inspect|stats|outline|status)(_|$)/i, op: "read" },
  { test: /(^|_)(create|update|patch|delete|write|set|put|save|merge|reply|send|react)(_|$)/i, op: "write" },
  { test: /(^|_)(search|find|query|recall|lookup|discover)(_|$)/i, op: "search" },
  { test: /(^|_)(spawn|launch|start|run|register)(_|$)/i, op: "spawn" },
  { test: /(^|_)(review|audit)(_|$)/i, op: "review" },
];

const HEURISTIC_DOM: Array<{ test: RegExp; dom: TargetDomain }> = [
  { test: /^github_/i, dom: "git" },
  { test: /^(gmail|google|microsoft|linkedin|crawl)_/i, dom: "http_api" },
  { test: /(^|_)(file|read_file|outline)/i, dom: "filesystem" },
  { test: /(^|_)(query|sql|db_)/i, dom: "db" },
  { test: /^(formation|browser_)/i, dom: "browser" },
  { test: /^(relay|ubik|agent|project|activity|inbox|paperclip|desktop)_/i, dom: "agent_relay" },
];

function tagFromHeuristics(toolName: string): ToolTag {
  const ops = new Set<OperationClass>();
  for (const h of HEURISTIC_OP) if (h.test.test(toolName)) ops.add(h.op);
  if (ops.size === 0) ops.add("read");
  const doms = new Set<TargetDomain>();
  for (const h of HEURISTIC_DOM) if (h.test.test(toolName)) doms.add(h.dom);
  if (doms.size === 0) doms.add("http_api");
  return { operation_classes: [...ops], target_domains: [...doms] };
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Tag a tool by name. Most specific catalog match wins; falls back to heuristics. */
export function tagTool(toolName: string): ToolTag {
  let best: { len: number; entry: CatalogEntry } | null = null;
  for (const [pattern, entry] of Object.entries(CATALOG)) {
    const matches = entry.match === "exact" ? toolName === pattern : toolName.startsWith(pattern);
    if (!matches) continue;
    if (!best || pattern.length > best.len) best = { len: pattern.length, entry };
  }
  if (best) {
    return {
      operation_classes: [...best.entry.operation_classes],
      target_domains: [...best.entry.target_domains],
    };
  }
  return tagFromHeuristics(toolName);
}

/** Score how well a tool matches a mission matrix. 0 = no match, higher = better. */
export function matchScore(tag: ToolTag, mission: MissionMatrix): number {
  const opHits = tag.operation_classes.filter((c) => mission.operations.includes(c)).length;
  const domHits = tag.target_domains.filter((d) => mission.domains.includes(d)).length;
  if (opHits === 0 || domHits === 0) return 0;
  return opHits * 10 + domHits;  // operation match weighted higher than domain
}

export type ToolCandidate = { name: string; server?: string };

export type ToolkitItem = {
  name: string;
  server: string;
  tag: ToolTag;
  score: number;
  reason: "matrix" | "always_include";
};

export type BuildToolkitInput = {
  candidates: ToolCandidate[];
  mission: MissionMatrix;
  manifest?: AgentManifest;
  top_k?: number;
};

/** Deterministic toolkit builder. Pure function, no I/O.
 *
 * 1. Tag each candidate.
 * 2. Drop those excluded by manifest (exclude_tools, exclude_classes, exclude_domains).
 * 3. Score remaining against mission matrix.
 * 4. Sort by score desc, take top_k (default 8).
 * 5. Force-add manifest.always_include items at the head (deduped).
 */
export function buildToolkit({
  candidates,
  mission,
  manifest,
  top_k = 8,
}: BuildToolkitInput): ToolkitItem[] {
  const excludeTools = new Set(manifest?.exclude_tools ?? []);
  const excludeClasses = new Set<OperationClass>(manifest?.exclude_classes ?? []);
  const excludeDomains = new Set<TargetDomain>(manifest?.exclude_domains ?? []);
  const alwaysInclude = manifest?.always_include ?? [];

  const tagged: ToolkitItem[] = [];
  for (const cand of candidates) {
    if (excludeTools.has(cand.name)) continue;
    const tag = tagTool(cand.name);
    if (tag.operation_classes.every((c) => excludeClasses.has(c))) continue;
    if (tag.target_domains.every((d) => excludeDomains.has(d))) continue;
    const score = matchScore(tag, mission);
    if (score === 0) continue;
    tagged.push({
      name: cand.name,
      server: cand.server ?? "?",
      tag,
      score,
      reason: "matrix",
    });
  }

  tagged.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const picked = tagged.slice(0, Math.max(0, top_k));

  // Force-include items declared in manifest.always_include, at the head, deduped.
  if (alwaysInclude.length > 0) {
    const have = new Set(picked.map((p) => p.name));
    const forced: ToolkitItem[] = [];
    for (const name of alwaysInclude) {
      if (have.has(name)) continue;
      const cand = candidates.find((c) => c.name === name);
      forced.push({
        name,
        server: cand?.server ?? "?",
        tag: tagTool(name),
        score: Number.POSITIVE_INFINITY,
        reason: "always_include",
      });
      have.add(name);
    }
    return [...forced, ...picked];
  }

  return picked;
}
