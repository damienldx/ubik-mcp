#!/usr/bin/env tsx
/**
 * measure-scope.ts — Phase 3 harness (plan_af2a4e47). CWD-INDEPENDENT (M1 lesson:
 * paths resolved via import.meta.url, not process.cwd()).
 *
 * Does two things, both offline-safe:
 *   1) PURE non-régression + filter tests (no network) — incl. GATE #1: an inactive
 *      perimeter returns the union BYTE-IDENTICAL (header/role absent = no-op).
 *   2) LIVE measurement (if :8902 reachable, read-only client): real union tools/list
 *      → filtered per role → resident size + gain. count_tokens exact is NOT reachable
 *      in this env (no Anthropic key / tiktoken — same as M1) → proxy chars/3.6, stated.
 *
 * The live step CONSUMES the shared :8902 as a read-only client (one extra session,
 * like any consumer) — it NEVER modifies the gateway server. Run:
 *   tsx src/measure-scope.ts            # pure tests + live measure (worker, lead)
 *   GW_URL=http://127.0.0.1:8902/mcp tsx src/measure-scope.ts
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  filterTools, makePerimeter, resolvePerimeter, BUILTIN_PERIMETERS, STEP0_FLOOR,
} from "./scoped-filter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHARS_PER_TOK = 3.6; // M1 proxy; count_tokens exact unreachable offline
const tok = (chars: number) => Math.round(chars / CHARS_PER_TOK);

type Tool = { name: string; description?: string; inputSchema?: unknown };

function residentChars(tools: Tool[]): number {
  return JSON.stringify(tools).length;
}

// ── 1) PURE TESTS (no network) ──────────────────────────────────────────────
function runPureTests(): boolean {
  let ok = true;
  const log = (name: string, pass: boolean, extra = "") => {
    ok = ok && pass;
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  };
  const sample: Tool[] = [
    { name: "skills.skills_recall" }, { name: "workspace.qubik_suggest" },
    { name: "workspace.qubik_record_usage" }, { name: "workspace.agent_workspace_create" },
    { name: "google.gmail_send_message" }, { name: "microsoft.microsoft_send_email" },
    { name: "linkedin.linkedin_create_post" }, { name: "browser.browser_click" },
    { name: "crawl.crawl_fetch_page" }, { name: "formation.formation_key" },
  ];

  // GATE #1: inactive perimeter = strict identity (byte-identical)
  const inactive = makePerimeter([], []);
  const passthru = filterTools(sample, inactive);
  log("GATE#1 inactive perimeter = identity (no-op)",
      JSON.stringify(passthru) === JSON.stringify(sample) && passthru.length === sample.length);

  // worker default {skills, workspace}: keeps skills.* + workspace.*, drops the rest
  const worker = resolvePerimeter("worker", undefined, () => null);
  const wf = filterTools(sample, worker);
  const wNames = wf.map((t) => t.name);
  log("worker keeps skills+workspace, drops google/ms/linkedin/browser/crawl/formation",
      wNames.includes("skills.skills_recall") && wNames.includes("workspace.qubik_suggest")
        && !wNames.includes("google.gmail_send_message") && !wNames.includes("linkedin.linkedin_create_post"),
      `kept ${wf.length}/${sample.length}`);

  // STEP-0 floor always present when active, even with a tight perimeter
  const tight = makePerimeter(["browser"], []); // role that only allows browser
  const tf = filterTools(sample, tight).map((t) => t.name);
  log("STEP-0 floor preserved under a tight perimeter",
      STEP0_FLOOR.every((b) => tf.some((n) => n.endsWith("." + b) || n === b)));

  // [gateway-tools] fine grain: allow a single tool by base-name
  const fine = makePerimeter([], ["gmail_send_message"]);
  const ff = filterTools(sample, fine).map((t) => t.name);
  log("[gateway-tools] base-name allow works",
      ff.includes("google.gmail_send_message"));

  // section parsing
  const parsed = resolvePerimeter("worker", "/dev/null/forced",
    () => "[gateway]\nskills\nworkspace\n[gateway-tools]\n# c\nqubik_suggest\n");
  log("parseScopeSections reads [gateway] + [gateway-tools]",
      parsed.servers.has("skills") && parsed.servers.has("workspace") && parsed.tools.has("qubik_suggest"));

  return ok;
}

// ── 2) LIVE measurement (read-only client to :8902) ─────────────────────────
async function liveMeasure(): Promise<void> {
  const url = process.env.GW_URL || "http://127.0.0.1:8902/mcp";
  let Client: any, Transport: any;
  try {
    ({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
    ({ StreamableHTTPClientTransport: Transport } =
      await import("@modelcontextprotocol/sdk/client/streamableHttp.js"));
  } catch (e) {
    console.log(`\n[live] SDK unavailable (${(e as Error).message}) — skipping live measure.`);
    return;
  }
  const c = new Client({ name: "measure-scope", version: "1.0.0" }, { capabilities: {} });
  let union: Tool[];
  try {
    await c.connect(new Transport(new URL(url)));
    union = (await c.listTools()).tools as Tool[];
  } catch (e) {
    console.log(`\n[live] :8902 unreachable (${(e as Error).message}) — skipping live measure.`);
    return;
  }
  const baseChars = residentChars(union);
  console.log(`\n[live] union @ ${url}: ${union.length} tools, ${baseChars} chars ≈ ${tok(baseChars)} tok (chars/3.6 proxy; count_tokens exact unreachable, cf M1)`);

  for (const role of ["worker", "lead"]) {
    const p = resolvePerimeter(role, undefined, () => null);
    const f = filterTools(union, p);
    const fChars = residentChars(f);
    const gain = baseChars - fChars;
    console.log(`[live] ${role.toUpperCase()} [gateway]={${[...p.servers].join(",")}} → ${f.length} tools, ${fChars} chars ≈ ${tok(fChars)} tok | GAIN ≈ ${tok(gain)} tok/slot (${union.length - f.length} tools dropped)`);
  }
  await c.close().catch(() => {});
}

(async () => {
  console.log("=== Phase 3 scoped-filter — PURE TESTS (gate #1 non-régression) ===");
  const pureOk = runPureTests();
  await liveMeasure();
  console.log(`\nPURE TESTS: ${pureOk ? "ALL PASS" : "FAILURES"} (gate #1 = non-régression header/role-absent)`);
  process.exit(pureOk ? 0 : 1);
})();
