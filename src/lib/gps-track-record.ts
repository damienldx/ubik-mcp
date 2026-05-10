/**
 * GPS Track Record — per-agent persistent memory.
 *
 * Stores `~/.ubik-memory/gps/<agent_id>.json` with:
 *  - tools_actually_used:  tool name → cumulative call count
 *  - hit_rate_history:     last N (fork_id, rate, recommended, called) entries
 *  - low_hit_classes:      operation classes whose hit_rate < threshold over window
 *  - catches (optional):   review catches contributed by hooks at session close
 *
 * The hit_rate is the fraction of recommended tools that the agent actually
 * called during a fork. A class (mail, social, drive, …) that consistently
 * scores < HIT_RATE_THRESHOLD over HIT_RATE_WINDOW forks is added to
 * `low_hit_classes` and excluded from future suggestions for that agent.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export const TRACK_DIR = path.join(homedir(), ".ubik-memory", "gps");
export const HIT_RATE_THRESHOLD = 0.2;
export const HIT_RATE_WINDOW = 5;
export const HISTORY_MAX = 50;

export type HitRateEntry = {
  fork_id: string;
  rate: number;
  date: string;
  recommended: string[];
  called: string[];
};

export type CatchEntry = {
  date: string;
  type: string;
  desc: string;
};

export type TrackRecord = {
  agent_id: string;
  tools_actually_used: Record<string, number>;
  hit_rate_history: HitRateEntry[];
  low_hit_classes: string[];
  catches?: CatchEntry[];
  last_updated: string;
};

function emptyRecord(agent_id: string): TrackRecord {
  return {
    agent_id,
    tools_actually_used: {},
    hit_rate_history: [],
    low_hit_classes: [],
    catches: [],
    last_updated: new Date().toISOString(),
  };
}

function recordPath(agent_id: string): string {
  const safe = agent_id.replace(/[^a-zA-Z0-9_\-.]/g, "_");
  return path.join(TRACK_DIR, `${safe}.json`);
}

export async function loadTrackRecord(agent_id: string): Promise<TrackRecord> {
  try {
    const raw = await fs.readFile(recordPath(agent_id), "utf8");
    const parsed = JSON.parse(raw) as Partial<TrackRecord>;
    return {
      agent_id,
      tools_actually_used: parsed.tools_actually_used ?? {},
      hit_rate_history: parsed.hit_rate_history ?? [],
      low_hit_classes: parsed.low_hit_classes ?? [],
      catches: parsed.catches ?? [],
      last_updated: parsed.last_updated ?? new Date().toISOString(),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyRecord(agent_id);
    throw err;
  }
}

export async function saveTrackRecord(record: TrackRecord): Promise<void> {
  await fs.mkdir(TRACK_DIR, { recursive: true });
  const final = { ...record, last_updated: new Date().toISOString() };
  const target = recordPath(record.agent_id);
  // Atomic write: tmp → rename. Concurrent recordUsage() calls for the same
  // agent can still last-writer-wins on the rename, but no caller ever sees
  // a half-written file.
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(final, null, 2), "utf8");
  await fs.rename(tmp, target);
}

/**
 * Map a tool name to a coarse operation class. Used for low-hit-rate exclusion:
 * one bad tool doesn't poison its class, but a class that consistently misses
 * (e.g. an agent who never sends emails) gets excluded wholesale.
 *
 * Convention: prefix before the first underscore, with a few hand-tuned merges
 * (linkedin → social, microsoft_outlook_* → email, etc).
 */
export function operationClassOf(toolName: string): string {
  const t = toolName.toLowerCase();
  if (t.startsWith("gmail_")) return "email";
  if (t.startsWith("linkedin_")) return "social";
  if (t.includes("outlook")) return "email";
  if (t.includes("drive")) return "drive";
  if (t.startsWith("google_docs") || t.includes("docs_")) return "docs";
  if (t.startsWith("google_sheets") || t.includes("sheets_")) return "sheets";
  if (t.startsWith("google_calendar") || t.includes("calendar")) return "calendar";
  if (t.startsWith("crawl_")) return "web_crawl";
  if (t.startsWith("github_")) return "github";
  if (t.startsWith("review_")) return "review";
  if (t.startsWith("skills_")) return "skills";
  if (t.startsWith("gps_")) return "gps";
  if (t.startsWith("agent_") || t.startsWith("ubik_")) return "fleet";
  if (t.startsWith("relay_")) return "relay";
  const idx = t.indexOf("_");
  return idx > 0 ? t.slice(0, idx) : t;
}

export function computeHitRate(recommended: string[], called: string[]): number {
  if (!recommended.length) return 0;
  const calledSet = new Set(called);
  let hit = 0;
  for (const r of recommended) if (calledSet.has(r)) hit += 1;
  return hit / recommended.length;
}

/**
 * Recompute `low_hit_classes` from the last `window` history entries.
 * For each class, looks at how often a tool of that class was recommended
 * AND not called. Class is "low-hit" iff its per-class hit rate is below
 * threshold AND it appeared in at least `window` entries.
 */
export function computeLowHitClasses(
  history: HitRateEntry[],
  window: number = HIT_RATE_WINDOW,
  threshold: number = HIT_RATE_THRESHOLD,
): string[] {
  const recent = history.slice(-window);
  if (recent.length < window) return [];

  const perClass = new Map<string, { reco: number; hit: number; appeared_in: number }>();
  for (const entry of recent) {
    const calledSet = new Set(entry.called);
    const seenInEntry = new Set<string>();
    for (const tool of entry.recommended) {
      const cls = operationClassOf(tool);
      const acc = perClass.get(cls) ?? { reco: 0, hit: 0, appeared_in: 0 };
      acc.reco += 1;
      if (calledSet.has(tool)) acc.hit += 1;
      if (!seenInEntry.has(cls)) {
        acc.appeared_in += 1;
        seenInEntry.add(cls);
      }
      perClass.set(cls, acc);
    }
  }

  const low: string[] = [];
  for (const [cls, stats] of perClass.entries()) {
    if (stats.appeared_in < window) continue;
    const rate = stats.reco === 0 ? 0 : stats.hit / stats.reco;
    if (rate < threshold) low.push(cls);
  }
  return low.sort();
}

/**
 * Append a usage observation, refresh `tools_actually_used` counters and
 * `low_hit_classes`. Returns the updated record (also persisted).
 */
export async function recordUsage(
  agent_id: string,
  fork_id: string,
  recommended: string[],
  called: string[],
): Promise<TrackRecord> {
  const record = await loadTrackRecord(agent_id);

  for (const tool of called) {
    record.tools_actually_used[tool] = (record.tools_actually_used[tool] ?? 0) + 1;
  }

  const entry: HitRateEntry = {
    fork_id,
    rate: computeHitRate(recommended, called),
    date: new Date().toISOString(),
    recommended,
    called,
  };
  record.hit_rate_history.push(entry);
  if (record.hit_rate_history.length > HISTORY_MAX) {
    record.hit_rate_history = record.hit_rate_history.slice(-HISTORY_MAX);
  }

  record.low_hit_classes = computeLowHitClasses(record.hit_rate_history);

  await saveTrackRecord(record);
  return record;
}

/**
 * Filter a list of recommended tools by removing those whose operation_class
 * is in `low_hit_classes`. Returns the filter outcome so callers can keep
 * a trace of what was pruned (debug / observability).
 */
export function filterByLowHitClasses(
  recommended: string[],
  lowHitClasses: string[],
): { kept: string[]; pruned: Array<{ tool: string; class: string }> } {
  if (!lowHitClasses.length) return { kept: [...recommended], pruned: [] };
  const lowSet = new Set(lowHitClasses);
  const kept: string[] = [];
  const pruned: Array<{ tool: string; class: string }> = [];
  for (const tool of recommended) {
    const cls = operationClassOf(tool);
    if (lowSet.has(cls)) pruned.push({ tool, class: cls });
    else kept.push(tool);
  }
  return { kept, pruned };
}

/**
 * Build an enriched persona label, e.g. "Albert — Reviewer Backend (4 catches, semaine 2026-05-10)".
 * Returns the base name unchanged when no catches are recorded for the current ISO week.
 */
export function enrichPersonaLabel(record: TrackRecord, baseName: string): string {
  const catches = record.catches ?? [];
  if (catches.length === 0) return baseName;

  const now = new Date();
  const week = isoWeekStart(now);
  const recent = catches.filter((c) => {
    try {
      return new Date(c.date) >= week;
    } catch {
      return false;
    }
  });
  if (recent.length === 0) return baseName;

  const stamp = formatDateYMD(now);
  return `${baseName} (${recent.length} catches, semaine ${stamp})`;
}

function isoWeekStart(d: Date): Date {
  const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() - day + 1);
  utc.setUTCHours(0, 0, 0, 0);
  return utc;
}

function formatDateYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
