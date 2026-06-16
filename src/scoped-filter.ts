/**
 * scoped-filter.ts — Phase 3 gateway role-scoping (POC, plan_af2a4e47).
 *
 * Pure, SOURCE-AGNOSTIC tool filtering for the :8902 union gateway. Reusable by
 * BOTH wiring paths so the filter logic lives in ONE place:
 *   • header path (http-server.ts reads X-Ubik-Role → resolve perimeter → filter
 *     the per-session tools/list RESPONSE; the aggregator built once at boot is
 *     untouched);
 *   • stdio fallback (per-agent proxy reads UBIK_GATEWAY_SCOPE_FILE / role).
 *
 * Contract (Oscar, new tools.scope sections — SOURCE UNIQUE, composes with M1):
 *   [gateway]        → allowed INTERNAL servers of the union (e.g. skills, workspace)
 *   [gateway-tools]  → (optional) extra allowed tool base-names (fine grain)
 *   allowed = serverOf(tool) ∈ [gateway]  OR  baseOf(tool) ∈ [gateway-tools]
 *   BOTH sections absent  →  no scoping  →  full union returned (no-op, retro-compat).
 *
 * Union tool names are "<server>.<tool>" (gateway aggregator naming, gateway.ts
 * buildAggregator: `${srv.name}.${tool.name}`).
 *
 * GATE #1 (Primus, non-régression): with an INACTIVE perimeter (no [gateway]/
 * [gateway-tools], or no role) filterTools is the IDENTITY — the union is returned
 * byte-for-byte. This is what guarantees header-absent / role-absent connections
 * keep today's behaviour exactly.
 */

export interface Perimeter {
  /** allowed internal server names (from [gateway]) */
  servers: Set<string>;
  /** allowed tool base-names (from [gateway-tools]) */
  tools: Set<string>;
  /** false → no scoping (identity passthrough = retro-compat no-op) */
  active: boolean;
}

/** STEP-0 floor: tools every scoped role keeps, so a tight perimeter never breaks
 *  the mandatory auto-equip step (qubik_suggest / skills_recall / qubik_record_usage). */
export const STEP0_FLOOR = ["qubik_suggest", "qubik_record_usage", "skills_recall"];

/** Built-in POC perimeters (used when no UBIK_GATEWAY_SCOPE_FILE is provided).
 *  lead/worker both scope to {skills, workspace} at server granularity — capturing
 *  the gisement (google/microsoft/linkedin + browser/crawl/formation dropped),
 *  consistent with M1's finding that lead/worker mount the same servers (role
 *  differentiation can be refined per-tool via [gateway-tools]). */
export const BUILTIN_PERIMETERS: Record<string, { servers?: string[]; tools?: string[] }> = {
  worker: { servers: ["skills", "workspace"] },
  lead:   { servers: ["skills", "workspace"] },
};

export function serverOf(name: string): string {
  const i = name.indexOf(".");
  return i >= 0 ? name.slice(0, i) : "";
}

export function baseOf(name: string): string {
  const i = name.indexOf(".");
  return i >= 0 ? name.slice(i + 1) : name;
}

/** Parse an INI-like tools.scope text → its [gateway] / [gateway-tools] entries. */
export function parseScopeSections(text: string): { servers: string[]; tools: string[] } {
  const servers: string[] = [];
  const tools: string[] = [];
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^\[(.+)\]$/);
    if (m) { section = m[1].trim(); continue; }
    if (section === "gateway") servers.push(line);
    else if (section === "gateway-tools") tools.push(line);
  }
  return { servers, tools };
}

/** Build a Perimeter from explicit server/tool lists. Empty both → inactive (no-op). */
export function makePerimeter(servers: string[] = [], tools: string[] = []): Perimeter {
  const active = servers.length > 0 || tools.length > 0;
  const toolSet = new Set(tools);
  // STEP-0 floor only when scoping is active (so a no-op stays a strict identity).
  if (active) for (const t of STEP0_FLOOR) toolSet.add(t);
  return { servers: new Set(servers), tools: toolSet, active };
}

/** Resolve a role's perimeter, preferring a tools.scope file, else the built-in.
 *  `readFile` is injected so this module stays pure/testable (no fs import here). */
export function resolvePerimeter(
  role: string,
  scopeFilePath: string | undefined,
  readFile: (p: string) => string | null,
): Perimeter {
  if (scopeFilePath) {
    const text = readFile(scopeFilePath);
    if (text != null) {
      const { servers, tools } = parseScopeSections(text);
      return makePerimeter(servers, tools);
    }
  }
  const b = BUILTIN_PERIMETERS[role];
  if (b) return makePerimeter(b.servers ?? [], b.tools ?? []);
  // Unknown role / no config → inactive → full union (safe, retro-compat).
  return makePerimeter([], []);
}

/** Filter a union tool list by perimeter. INACTIVE perimeter → identity (gate #1). */
export function filterTools<T extends { name: string }>(tools: T[], p: Perimeter): T[] {
  if (!p.active) return tools;
  return tools.filter(
    (t) => p.servers.has(serverOf(t.name)) || p.tools.has(baseOf(t.name)) || p.tools.has(t.name),
  );
}
