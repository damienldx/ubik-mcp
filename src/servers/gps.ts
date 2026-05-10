#!/usr/bin/env node
/**
 * GPS MCP server — pull-based mission briefing for fleet agents.
 *
 * Tools (3):
 *   - gps_brief(message)         Returns a full mission GPS: persona, system_prompt, recommended tools, route, risks.
 *   - gps_hint(message)          Lightweight: returns a score 0-1 + suggested persona name; intended for relay headers.
 *   - gps_persona(query)         Direct persona lookup by free-text query (skip message analysis).
 *
 * Design choice (vs always-enrich-relay_read): GPS is opt-in, called by the
 * agent when it judges the message complex enough to warrant it. Avoids
 * context pollution when several messages arrive in quick succession.
 *
 * Data source: data/skills-seed.json bundled in the repo (2385 curated skills).
 * Pure stdlib — only @modelcontextprotocol/sdk, zod, dotenv, node:* imports.
 */

import { z } from "zod";
import { config } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createMcpServer, runServer } from "../lib/server.js";

config();

interface Skill {
  id:            string;
  name:          string;
  domain:        string;
  description:   string;
  system_prompt: string;
  tools:         string[];
  tags:          string[];
}

interface SkillsBundle {
  version: number;
  count:   number;
  skills:  Skill[];
}

// ─── Skill bundle loading ────────────────────────────────────────────────────

function locateBundle(): string {
  const env = process.env.GPS_SKILLS_PATH;
  if (env && fs.existsSync(env)) return env;
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../data/skills-seed.json"),
    path.resolve(here, "../../../data/skills-seed.json"),
    path.resolve(process.cwd(), "data/skills-seed.json"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(
    "GPS skills bundle not found. Set GPS_SKILLS_PATH or run from repo root with data/skills-seed.json present.",
  );
}

let _bundle: SkillsBundle | null = null;

function bundle(): SkillsBundle {
  if (_bundle) return _bundle;
  const raw = fs.readFileSync(locateBundle(), "utf-8");
  const parsed = JSON.parse(raw) as SkillsBundle;
  if (!Array.isArray(parsed.skills)) throw new Error("Invalid bundle: skills array missing");
  _bundle = parsed;
  return parsed;
}

// ─── Intent extraction ───────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "your", "you", "are",
  "le", "la", "les", "des", "un", "une", "de", "du", "et", "ou", "à", "au", "aux",
  "dans", "pour", "avec", "sur", "par", "ce", "cette", "ces", "il", "elle", "ils",
  "nous", "vous", "qui", "que", "quoi", "ne", "pas", "est", "sont", "été", "être",
  "ai", "as", "a", "ont", "fait", "faire", "tu", "moi", "toi", "ton", "ta", "tes",
  "mon", "ma", "mes", "notre", "votre", "leur", "leurs", "se", "sa", "ses",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

function scoreSkill(skill: Skill, tokens: string[]): number {
  if (!tokens.length) return 0;
  const haystackName   = `${skill.name} ${skill.id}`.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const haystackDomain = skill.domain.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const haystackTags   = skill.tags.join(" ").toLowerCase();
  const haystackDesc   = skill.description.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

  let score = 0;
  for (const t of tokens) {
    if (haystackName.includes(t))   score += 4;   // strongest signal
    if (haystackDomain.includes(t)) score += 3;
    if (haystackTags.includes(t))   score += 2;
    if (haystackDesc.includes(t))   score += 1;
  }
  return score;
}

function bestSkill(message: string): { skill: Skill | null; score: number } {
  const tokens = tokenize(message);
  if (!tokens.length) return { skill: null, score: 0 };
  let best: Skill | null = null;
  let bestScore = 0;
  for (const s of bundle().skills) {
    const sc = scoreSkill(s, tokens);
    if (sc > bestScore) {
      bestScore = sc;
      best = s;
    }
  }
  return { skill: best, score: bestScore };
}

// ─── Route + risks composition ───────────────────────────────────────────────

const VERB_TO_ROUTE: Array<{ patterns: RegExp[]; route: string[] }> = [
  {
    patterns: [/\b(implement|code|write|build|create|add|extend|enrich)\b/i, /\b(implé|écris|construis|crée|ajoute|étend)\w*/i],
    route: [
      "Read the surrounding code to understand the existing pattern",
      "Identify the contract (signatures, side effects, data shape)",
      "Implement the change in the smallest reversible step",
      "Run a smoke test or build to confirm the change compiles",
      "Commit with a focused message tied to the requested feature",
    ],
  },
  {
    patterns: [/\b(fix|debug|repair|patch|resolve)\b/i, /\b(corrig|déboggu|répar|résous)\w*/i],
    route: [
      "Reproduce the bug locally with the smallest input that triggers it",
      "Read the failing path top-to-bottom (no skipping)",
      "Form one hypothesis, instrument it, validate or refute",
      "Apply the minimal fix; avoid drive-by changes",
      "Add a regression check if the affected path lacks one",
    ],
  },
  {
    patterns: [/\b(review|audit|inspect|verify|check)\b/i, /\b(reviewe|audit|vérifi|inspect|contrôl)\w*/i],
    route: [
      "Read the diff end-to-end before commenting",
      "Trace race / lock / loop hazards on async or shared-state code",
      "Verify error paths and edge cases (empty input, network failure, idempotency)",
      "Check for ecosystem hooks the change may have missed",
      "Summarise findings as GREEN / nits / blockers",
    ],
  },
  {
    patterns: [/\b(deploy|ship|release|push|publish)\b/i, /\b(déploi|publi|livr|envoi)\w*/i],
    route: [
      "Confirm the artefact is the one being released (sha, branch)",
      "Check rollback path is defined before pushing",
      "Run pre-deploy checks (lint, test, build) explicitly",
      "Push and verify deployment via health endpoint or smoke",
      "Notify operator with link to the deployed surface",
    ],
  },
  {
    patterns: [/\b(analyze|analyse|investigate|study|examine|map|cartograph|audit)\b/i, /\b(analys|investigu|étudi|examin|cartograph|audit)\w*/i],
    route: [
      "Define the scope precisely (what is in, what is out)",
      "Sample before generalising (5-10 instances, not the whole population)",
      "Cross-reference 2-3 angles before concluding",
      "Quantify when possible (counts, percentages, ratios)",
      "Deliver findings with a recommendation, not just data",
    ],
  },
];

const DEFAULT_ROUTE = [
  "Re-read the message — confirm what is asked vs what is implied",
  "Inventory the existing artefacts touched by this mission",
  "Take the smallest reversible action that produces a visible signal",
  "Verify the signal matches the expectation",
  "Report back with a concrete delivery (file, PR, message)",
];

function buildRoute(message: string): string[] {
  for (const entry of VERB_TO_ROUTE) {
    if (entry.patterns.some((p) => p.test(message))) return entry.route;
  }
  return DEFAULT_ROUTE;
}

const STANDARD_RISKS = [
  "Re-entrant loop: ensure hooks do not re-trigger themselves on their own output",
  "Race on shared mutable state: identify the lock or the single-writer guarantee",
  "Idempotency: rerunning the same operation must not double-write or duplicate side effects",
  "Irreversible action: pause and confirm before destructive operations (rm, drop, push --force)",
  "Trust boundary: do not let user-controlled input set tags or flags that gate critical logic",
];

function pickRisks(skill: Skill | null): string[] {
  if (!skill) return STANDARD_RISKS.slice(0, 3);
  const domain = skill.domain.toLowerCase();
  const extra: string[] = [];
  if (domain.includes("api") || domain.includes("graphql") || domain.includes("grpc")) {
    extra.push("API contract: schema additions are safe; removals/renames are breaking — treat them with version gates");
  }
  if (domain.includes("ml") || domain.includes("apprentissage")) {
    extra.push("Training/inference drift: validate the model behaviour on held-out data before promoting");
  }
  if (domain.includes("react") || domain.includes("frontend") || domain.includes("vue")) {
    extra.push("Render path: keep state, derived state, and effects clearly separated to avoid stale UI");
  }
  if (domain.includes("scalab")) {
    extra.push("Backpressure: ensure the slowest downstream consumer cannot collapse the upstream producer");
  }
  return [...STANDARD_RISKS.slice(0, 3), ...extra];
}

// ─── Output composition ──────────────────────────────────────────────────────

function buildBrief(message: string) {
  const { skill, score } = bestSkill(message);
  const route = buildRoute(message);
  const risks = pickRisks(skill);
  const tools = skill?.tools?.slice(0, 8) ?? [];
  const summary = message.trim().split("\n")[0].slice(0, 200);

  return {
    mission_summary:    summary,
    persona:            skill ? { id: skill.id, name: skill.name, domain: skill.domain } : null,
    persona_score:      score,
    system_prompt:      skill ? skill.system_prompt : "",
    recommended_tools:  tools,
    route,
    risks,
    notes:              skill
      ? `Persona auto-selected from ${bundle().skills.length} skills via keyword scoring. Override via gps_persona(query) if mismatch.`
      : `No persona matched the message tokens. Falling back to a generic route. Try gps_persona with a more specific query.`,
  };
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = createMcpServer("ubik-gps");

server.tool(
  "gps_brief",
  "Returns a full mission GPS for a message: persona, system_prompt, recommended tools, route, risks. Pull-based — opt-in per message to avoid context pollution.",
  {
    message: z.string().min(1).describe("The relay message or task to brief on (full text)"),
  },
  async ({ message }) => {
    return { content: [{ type: "text" as const, text: JSON.stringify(buildBrief(message), null, 2) }] };
  },
);

server.tool(
  "gps_hint",
  "Lightweight pre-screen: returns a score 0-1 indicating whether gps_brief is worth calling, plus the candidate persona name. Designed to be embeddable as a header in relay_read responses.",
  {
    message:  z.string().min(1).describe("Message to pre-screen"),
    minScore: z.number().int().nonnegative().optional().describe("Minimum scoring threshold (default 4 — at least one tag-or-better hit)"),
  },
  async ({ message, minScore }) => {
    const threshold = minScore ?? 4;
    const { skill, score } = bestSkill(message);
    const tokens = tokenize(message);
    const briefRecommended = score >= threshold;
    const normalised = Math.min(1, score / 20);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          brief_recommended: briefRecommended,
          score:             normalised,
          raw_score:         score,
          token_count:       tokens.length,
          suggested_persona: skill ? { id: skill.id, name: skill.name, domain: skill.domain } : null,
        }, null, 2),
      }],
    };
  },
);

server.tool(
  "gps_persona",
  "Direct persona lookup by free-text query (skip message analysis). Returns the top match plus 4 alternates with scores.",
  {
    query: z.string().min(1).describe("Free-text query (domain, role, technology...)"),
    limit: z.number().int().positive().max(10).optional().describe("Max results returned (default 5)"),
  },
  async ({ query, limit }) => {
    const tokens = tokenize(query);
    const cap = limit ?? 5;
    const scored = bundle().skills
      .map((s) => ({ skill: s, score: scoreSkill(s, tokens) }))
      .filter((e) => e.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, cap);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          query,
          count: scored.length,
          results: scored.map(({ skill, score }) => ({
            id:          skill.id,
            name:        skill.name,
            domain:      skill.domain,
            score,
            description: skill.description.slice(0, 200),
            tools_top:   skill.tools.slice(0, 5),
          })),
        }, null, 2),
      }],
    };
  },
);

runServer(server).catch((err) => {
  process.stderr.write(`[ubik-gps] fatal: ${err}\n`);
  process.exit(1);
});
