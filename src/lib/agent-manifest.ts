/**
 * agent-manifest.ts — Per-agent overrides for GPS v2 toolkit assembly.
 *
 * Reads `~/.ubik-desktop/agents/<agent_id>.{yaml,yml,json}` once per call
 * (no in-process cache — the manifest is small and the lookup is rare).
 *
 * Schema (any subset, all optional) :
 *   exclude_classes: [social, network]
 *   exclude_domains: [browser]
 *   exclude_tools:   [github_create_repo]
 *   always_include:  [relay_send, github_get_repo]
 *
 * The YAML parser is intentionally minimal — it only understands the four
 * keys above and inline arrays. Comments (`#`) and blank lines are ignored.
 * Anything fancier should use `.json` instead.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type {
  AgentManifest,
  OperationClass,
  TargetDomain,
} from "./tool-taxonomy.js";
import { OPERATION_CLASSES, TARGET_DOMAINS } from "./tool-taxonomy.js";

const KNOWN_KEYS = new Set([
  "exclude_classes",
  "exclude_domains",
  "exclude_tools",
  "always_include",
]);

const DEFAULT_DIR = path.join(os.homedir(), ".ubik-desktop", "agents");

function manifestPath(agentId: string, baseDir = DEFAULT_DIR): string | null {
  for (const ext of [".yaml", ".yml", ".json"]) {
    const p = path.join(baseDir, `${agentId}${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Parses one inline-array YAML line: "key: [a, b, "c d"]" */
function parseInlineArray(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return [trimmed.replace(/^["']|["']$/g, "")].filter(Boolean);
  }
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  const items: string[] = [];
  let buf = "";
  let inQuote: string | null = null;
  for (const ch of inner) {
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === ",") {
      const v = buf.trim();
      if (v) items.push(v);
      buf = "";
      continue;
    }
    buf += ch;
  }
  const last = buf.trim();
  if (last) items.push(last);
  return items;
}

function parseManifestText(text: string, ext: string): Record<string, unknown> {
  if (ext === ".json") {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  // Minimal YAML — `key: [a, b]` per line, `#` for comments.
  const out: Record<string, string[]> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (!KNOWN_KEYS.has(key)) continue;
    const val = line.slice(idx + 1).trim();
    out[key] = parseInlineArray(val);
  }
  return out;
}

const OP_SET = new Set<string>(OPERATION_CLASSES);
const DOM_SET = new Set<string>(TARGET_DOMAINS);

function asOpClasses(arr: unknown): OperationClass[] | undefined {
  if (!Array.isArray(arr)) return undefined;
  return arr.filter((v): v is OperationClass => typeof v === "string" && OP_SET.has(v));
}

function asDomains(arr: unknown): TargetDomain[] | undefined {
  if (!Array.isArray(arr)) return undefined;
  return arr.filter((v): v is TargetDomain => typeof v === "string" && DOM_SET.has(v));
}

function asStrings(arr: unknown): string[] | undefined {
  if (!Array.isArray(arr)) return undefined;
  return arr.filter((v): v is string => typeof v === "string");
}

/**
 * Load and validate the manifest for one agent. Unknown / malformed values
 * are silently dropped (we don't want a typo in a manifest to block the agent).
 * Returns `null` when no manifest file exists.
 */
export function loadAgentManifest(
  agentId: string,
  baseDir = DEFAULT_DIR,
): AgentManifest | null {
  const file = manifestPath(agentId, baseDir);
  if (!file) return null;
  const ext = path.extname(file).toLowerCase();
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const raw = parseManifestText(text, ext);
  const manifest: AgentManifest = {};
  const ec = asOpClasses(raw.exclude_classes);
  if (ec && ec.length) manifest.exclude_classes = ec;
  const ed = asDomains(raw.exclude_domains);
  if (ed && ed.length) manifest.exclude_domains = ed;
  const et = asStrings(raw.exclude_tools);
  if (et && et.length) manifest.exclude_tools = et;
  const ai = asStrings(raw.always_include);
  if (ai && ai.length) manifest.always_include = ai;
  if (Object.keys(manifest).length === 0) return null;
  return manifest;
}
