#!/usr/bin/env node
/**
 * UBIK Formation — MCP Server (stdio transport)
 *
 * Interactive desktop automation training system.
 * The AI observes the user's screen, learns processes step by step,
 * and saves reusable protocols that can be replayed autonomously.
 *
 * Tools:
 *   - formation_screenshot     → Capture the user's screen (returns base64 image)
 *   - formation_click          → Click at screen coordinates
 *   - formation_type           → Type text on keyboard
 *   - formation_key            → Press a key or key combo (Enter, Ctrl+S, etc.)
 *   - formation_scroll         → Scroll in a direction
 *   - formation_screen_info    → Get screen size + active window info
 *   - formation_save_protocol  → Save a formation protocol for later replay
 *   - formation_list_protocols → List saved protocols
 *   - formation_get_protocol   → Get a protocol by name
 *   - formation_replay_step    → Execute a single step from a protocol
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { config } from "dotenv";

config({ path: path.join(process.cwd(), ".env") });

// ─── Agent RPC bridge ───
// Calls the UBIK server API which proxies to the local agent

const UBIK_BASE = process.env.UBIK_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || "";
const DEFAULT_USER_ID = process.env.UBIK_USER_ID || process.env.UBIK_DEFAULT_USER_ID || "default";

async function agentRpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${UBIK_BASE}/api/agent/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": INTERNAL_SECRET,
      "x-ubik-user-id": DEFAULT_USER_ID,
    },
    body: JSON.stringify({ method, params }),
  });
  if (!res.ok) {
    const text = await res.text();
    if (text.includes("Unknown method:")) {
      throw new Error(
        `Agent local trop ancien pour ${method}. Reinstallez/mettez a jour le bureau local avec le package courant via /api/agent/package, puis relancez l'agent.`,
      );
    }
    throw new Error(`Agent RPC failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  if (data.error) {
    const message = String(data.error);
    if (message.includes("Unknown method:")) {
      throw new Error(
        `Agent local trop ancien pour ${method}. Reinstallez/mettez a jour le bureau local avec le package courant via /api/agent/package, puis relancez l'agent.`,
      );
    }
    throw new Error(message);
  }
  return data.result;
}

// ─── Agent capability check ───

const REQUIRED_PROTOCOL_VERSION = "2";

interface AgentCapabilities {
  agentVersion: string;
  protocolVersion: string;
  capabilities: { screen?: Record<string, boolean>; pty?: { supported: boolean }; fs?: { supported: boolean } };
  environment: { display?: string; desktopAvailable?: boolean };
}

let cachedAgentInfo: AgentCapabilities | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000;

async function getAgentCapabilities(): Promise<AgentCapabilities> {
  if (cachedAgentInfo && (Date.now() - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedAgentInfo;
  }
  try {
    const info = await agentRpc("agent.info");
    cachedAgentInfo = info as AgentCapabilities;
    cacheTimestamp = Date.now();
    return cachedAgentInfo;
  } catch {
    return {
      agentVersion: "unknown",
      protocolVersion: "0",
      capabilities: {},
      environment: { desktopAvailable: false },
    };
  }
}

function checkAgentVersion(info: AgentCapabilities, method: string): void {
  if (info.protocolVersion === "0" || info.agentVersion === "unknown") {
    throw new Error(
      `Agent local introuvable ou non connecte. Impossible d'executer ${method}. ` +
      `Verifiez que l'agent desktop est demarre et connecte.`
    );
  }
  const proto = parseInt(info.protocolVersion || "0");
  const required = parseInt(REQUIRED_PROTOCOL_VERSION);
  if (proto < required) {
    throw new Error(
      `Agent local obsolete (v${info.agentVersion}, protocole ${info.protocolVersion}). ` +
      `Version minimale requise: protocole ${REQUIRED_PROTOCOL_VERSION}. ` +
      `Mettez a jour via: curl -fsSL $UBIK_HOST/api/agent/package | tar xz -C ~/.ubik-agent && systemctl --user restart ubik-agent`
    );
  }
}

function checkDesktopAvailable(info: AgentCapabilities, method: string): void {
  if (!info.environment?.desktopAvailable) {
    throw new Error(
      `Desktop non disponible sur l'agent local (DISPLAY non defini). ` +
      `Impossible d'executer ${method}. ` +
      `Verifiez que l'agent tourne dans une session graphique. ` +
      `Hint: relancez l'agent depuis un terminal graphique ou corrigez le service systemd.`
    );
  }
}

function checkScreenCapability(info: AgentCapabilities, capability: string, method: string): void {
  const screenCaps = info.capabilities?.screen || {};
  if (screenCaps[capability] === false) {
    throw new Error(
      `Dependance manquante: '${capability}' non installe sur l'agent local (v${info.agentVersion}). ` +
      `Impossible d'executer ${method}. ` +
      `Installez-le: sudo apt install ${capability === "scrot" ? "scrot" : capability === "tesseract" ? "tesseract-ocr" : capability}`
    );
  }
}

async function ensureDesktopReady(method: string): Promise<void> {
  const info = await getAgentCapabilities();
  checkAgentVersion(info, method);
  checkDesktopAvailable(info, method);
}

async function ensureScreenCapability(method: string, ...caps: string[]): Promise<void> {
  const info = await getAgentCapabilities();
  checkAgentVersion(info, method);
  checkDesktopAvailable(info, method);
  for (const cap of caps) {
    checkScreenCapability(info, cap, method);
  }
}

// ─── Protocol storage (PostgreSQL) ───

import { getPool } from "../lib/db/connection.js";

let _tableReady = false;
async function ensureProtocolTable(): Promise<void> {
  if (_tableReady) return;
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS formation_protocols (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      params JSONB DEFAULT '[]',
      steps JSONB DEFAULT '[]',
      version INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (now()::text),
      updated_at TEXT NOT NULL DEFAULT (now()::text)
    );
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_formation_user ON formation_protocols(user_id)");
  _tableReady = true;
}

// ─── MCP Server ───

const server = new McpServer({ name: "ubik-formation", version: "1.0.0" });

// ═══════════════════════════════════════
// SCREEN OBSERVATION
// ═══════════════════════════════════════

server.tool(
  "formation_screenshot",
  "Capture l'ecran de la machine locale de l'utilisateur. Retourne une image PNG en base64. Utilise cet outil pour VOIR ce qui se passe sur l'ecran avant d'agir.",
  {
    region_x: z.number().optional().describe("X de la zone a capturer (optionnel, defaut: ecran entier)"),
    region_y: z.number().optional().describe("Y de la zone a capturer"),
    region_w: z.number().optional().describe("Largeur de la zone"),
    region_h: z.number().optional().describe("Hauteur de la zone"),
  },
  async (args) => {
    await ensureDesktopReady("formation_screenshot");
    const params: Record<string, unknown> = {};
    if (args.region_x !== undefined) {
      params.region = { x: args.region_x, y: args.region_y, w: args.region_w, h: args.region_h };
    }
    const result = await agentRpc("screen.screenshot", params);
    return {
      content: [
        { type: "image" as const, data: result.image, mimeType: "image/png" },
        { type: "text" as const, text: "Screenshot captured." },
      ],
    };
  },
);

// ═══════════════════════════════════════
// SCREEN ACTIONS
// ═══════════════════════════════════════

server.tool(
  "formation_click",
  "Clique sur l'ecran aux coordonnees (x, y). Types: left (defaut), right, double.",
  {
    x: z.number().describe("Coordonnee X du clic"),
    y: z.number().describe("Coordonnee Y du clic"),
    type: z.enum(["left", "right", "double"]).default("left").describe("Type de clic"),
  },
  async (args) => {
    await ensureDesktopReady("formation_click");
    await agentRpc("screen.click", { x: args.x, y: args.y, type: args.type });
    return { content: [{ type: "text" as const, text: `Click ${args.type} at (${args.x}, ${args.y})` }] };
  },
);

server.tool(
  "formation_type",
  "Tape du texte au clavier, comme si l'utilisateur tapait.",
  {
    text: z.string().describe("Le texte a taper"),
  },
  async (args) => {
    await agentRpc("screen.type", { text: args.text });
    return { content: [{ type: "text" as const, text: `Typed: "${args.text.substring(0, 50)}${args.text.length > 50 ? "..." : ""}"` }] };
  },
);

server.tool(
  "formation_key",
  "Appuie sur une touche ou une combinaison de touches. Exemples: 'enter', 'tab', 'escape'. Pour les combos, utilise formation_hotkey.",
  {
    key: z.string().describe("Nom de la touche: enter, tab, escape, backspace, delete, up, down, left, right, f1-f12, space"),
  },
  async (args) => {
    await agentRpc("screen.keyPress", { key: args.key });
    return { content: [{ type: "text" as const, text: `Key pressed: ${args.key}` }] };
  },
);

server.tool(
  "formation_hotkey",
  "Execute un raccourci clavier (combinaison de touches). Exemples: ['ctrl','s'] pour sauvegarder, ['ctrl','c'] pour copier, ['alt','f4'] pour fermer.",
  {
    keys: z.array(z.string()).describe("Liste des touches dans l'ordre. Ex: ['ctrl','s'], ['ctrl','shift','n']"),
  },
  async (args) => {
    await agentRpc("screen.hotkey", { keys: args.keys });
    return { content: [{ type: "text" as const, text: `Hotkey: ${args.keys.join("+")}` }] };
  },
);

server.tool(
  "formation_scroll",
  "Scroll dans une direction.",
  {
    direction: z.enum(["up", "down", "left", "right"]).describe("Direction du scroll"),
    amount: z.number().default(3).describe("Nombre de crans (defaut: 3)"),
  },
  async (args) => {
    await agentRpc("screen.scroll", { direction: args.direction, amount: args.amount });
    return { content: [{ type: "text" as const, text: `Scrolled ${args.direction} x${args.amount}` }] };
  },
);

server.tool(
  "formation_screen_info",
  "Obtient les informations sur l'ecran: resolution et fenetre active.",
  {},
  async () => {
    await ensureDesktopReady("formation_screen_info");
    const [screenSize, activeWindow] = await Promise.all([
      agentRpc("screen.getScreenSize"),
      agentRpc("screen.getActiveWindow"),
    ]);
    return {
      content: [{
        type: "text" as const,
        text: `Screen: ${screenSize.width}x${screenSize.height}\nActive window: "${activeWindow.title}" at (${activeWindow.x},${activeWindow.y}) size ${activeWindow.w}x${activeWindow.h}`,
      }],
    };
  },
);

// ═══════════════════════════════════════
// PROTOCOL MANAGEMENT
// ═══════════════════════════════════════

server.tool(
  "formation_save_protocol",
  "Sauvegarde un protocole d'automatisation appris pendant la formation. Le protocole pourra etre rejoue plus tard.",
  {
    name: z.string().describe("Nom du protocole (ex: 'Saisir une facture Sage')"),
    description: z.string().optional().describe("Description de ce que fait le protocole"),
    params: z.array(z.object({
      name: z.string(),
      type: z.enum(["string", "number", "boolean"]),
      description: z.string(),
      default_value: z.string().optional(),
    })).optional().describe("Parametres variables du protocole"),
    steps: z.array(z.object({
      id: z.number(),
      action: z.string().describe("Type d'action: click, type, keyPress, hotkey, scroll, open_app, navigate_menu, fill_field, wait"),
      description: z.string().describe("Description humaine de l'etape"),
      params: z.record(z.unknown()).optional().describe("Parametres de l'action (x, y, text, key, etc.)"),
      checkpoint: z.string().optional().describe("Ce qu'on doit voir a l'ecran apres cette etape"),
      timeout_ms: z.number().optional().describe("Temps max d'attente (defaut: 5000ms)"),
    })).describe("Liste ordonnee des etapes du protocole"),
  },
  async (args) => {
    await ensureProtocolTable();
    const pool = getPool();
    const id = `proto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();

    await pool.query(
      `INSERT INTO formation_protocols (id, user_id, name, description, params, steps, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [id, DEFAULT_USER_ID, args.name, args.description || "", JSON.stringify(args.params || []), JSON.stringify(args.steps), now],
    );

    return { content: [{ type: "text" as const, text: `Protocole "${args.name}" sauvegarde (${args.steps.length} etapes). ID: ${id}` }] };
  },
);

server.tool(
  "formation_list_protocols",
  "Liste tous les protocoles d'automatisation sauvegardes.",
  {},
  async () => {
    await ensureProtocolTable();
    const pool = getPool();
    const result = await pool.query(
      "SELECT id, name, description, version, created_at FROM formation_protocols WHERE user_id = $1 ORDER BY created_at DESC",
      [DEFAULT_USER_ID],
    );
    if (result.rows.length === 0) {
      return { content: [{ type: "text" as const, text: "Aucun protocole sauvegarde." }] };
    }
    const list = result.rows.map((r: any) =>
      `- **${r.name}** (v${r.version}) — ${r.description || "pas de description"}\n  ID: ${r.id} | Cree: ${r.created_at}`
    ).join("\n");
    return { content: [{ type: "text" as const, text: `${result.rows.length} protocole(s):\n\n${list}` }] };
  },
);

server.tool(
  "formation_get_protocol",
  "Recupere un protocole par son nom ou ID pour voir ses etapes.",
  {
    name: z.string().describe("Nom ou ID du protocole"),
  },
  async (args) => {
    await ensureProtocolTable();
    const pool = getPool();
    const result = await pool.query(
      "SELECT * FROM formation_protocols WHERE (name = $1 OR id = $1) AND user_id = $2 LIMIT 1",
      [args.name, DEFAULT_USER_ID],
    );
    if (result.rows.length === 0) {
      return { content: [{ type: "text" as const, text: `Protocole "${args.name}" non trouve.` }] };
    }
    const proto = result.rows[0] as any;
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          name: proto.name,
          description: proto.description,
          params: proto.params,
          steps: proto.steps,
          version: proto.version,
        }, null, 2),
      }],
    };
  },
);

server.tool(
  "formation_replay_step",
  "Execute une action sur l'ecran de l'utilisateur. Utilise cet outil pour rejouer les etapes d'un protocole ou pour agir pendant une formation.",
  {
    action: z.enum(["click", "type", "keyPress", "hotkey", "scroll", "moveMouse", "drag", "screenshot", "wait"]).describe("Type d'action"),
    x: z.number().optional().describe("Coordonnee X (pour click, moveMouse, drag)"),
    y: z.number().optional().describe("Coordonnee Y"),
    x2: z.number().optional().describe("X destination (pour drag)"),
    y2: z.number().optional().describe("Y destination (pour drag)"),
    text: z.string().optional().describe("Texte a taper (pour type)"),
    key: z.string().optional().describe("Touche (pour keyPress)"),
    keys: z.array(z.string()).optional().describe("Combo de touches (pour hotkey)"),
    click_type: z.enum(["left", "right", "double"]).optional().describe("Type de clic"),
    direction: z.enum(["up", "down", "left", "right"]).optional().describe("Direction (pour scroll)"),
    amount: z.number().optional().describe("Quantite (pour scroll)"),
    wait_ms: z.number().optional().describe("Temps d'attente en ms (pour wait)"),
  },
  async (args) => {
    switch (args.action) {
      case "screenshot": {
        const result = await agentRpc("screen.screenshot");
        return {
          content: [
            { type: "image" as const, data: result.image, mimeType: "image/png" },
            { type: "text" as const, text: "Screenshot captured." },
          ],
        };
      }
      case "click":
        await agentRpc("screen.click", { x: args.x, y: args.y, type: args.click_type || "left" });
        return { content: [{ type: "text" as const, text: `Clicked (${args.x}, ${args.y})` }] };
      case "type":
        await agentRpc("screen.type", { text: args.text });
        return { content: [{ type: "text" as const, text: `Typed: "${args.text}"` }] };
      case "keyPress":
        await agentRpc("screen.keyPress", { key: args.key });
        return { content: [{ type: "text" as const, text: `Key: ${args.key}` }] };
      case "hotkey":
        await agentRpc("screen.hotkey", { keys: args.keys });
        return { content: [{ type: "text" as const, text: `Hotkey: ${args.keys?.join("+")}` }] };
      case "scroll":
        await agentRpc("screen.scroll", { direction: args.direction, amount: args.amount || 3 });
        return { content: [{ type: "text" as const, text: `Scrolled ${args.direction}` }] };
      case "moveMouse":
        await agentRpc("screen.moveMouse", { x: args.x, y: args.y });
        return { content: [{ type: "text" as const, text: `Mouse moved to (${args.x}, ${args.y})` }] };
      case "drag":
        await agentRpc("screen.drag", { x1: args.x, y1: args.y, x2: args.x2, y2: args.y2 });
        return { content: [{ type: "text" as const, text: `Dragged (${args.x},${args.y}) → (${args.x2},${args.y2})` }] };
      case "wait":
        await new Promise(resolve => setTimeout(resolve, args.wait_ms || 1000));
        return { content: [{ type: "text" as const, text: `Waited ${args.wait_ms || 1000}ms` }] };
      default:
        return { content: [{ type: "text" as const, text: `Unknown action: ${args.action}` }] };
    }
  },
);

// ═══════════════════════════════════════
// MODULE 1 — RDA VISION
// ═══════════════════════════════════════

server.tool(
  "rda_read_text",
  "OCR: Lit le texte affiche a l'ecran (ou dans une zone precise). Utilise Tesseract pour la reconnaissance optique. Langues: francais + anglais.",
  {
    region_x: z.number().optional().describe("X de la zone a lire"),
    region_y: z.number().optional().describe("Y de la zone a lire"),
    region_w: z.number().optional().describe("Largeur de la zone"),
    region_h: z.number().optional().describe("Hauteur de la zone"),
  },
  async (args) => {
    const region = args.region_x !== undefined
      ? { x: args.region_x, y: args.region_y!, w: args.region_w!, h: args.region_h! }
      : undefined;
    const result = await agentRpc("screen.readText", region ? { region } : {});
    return { content: [{ type: "text" as const, text: result.text || "(aucun texte detecte)" }] };
  },
);

server.tool(
  "rda_find_element",
  "Trouve un element sur l'ecran par son texte (OCR + localisation). Retourne les coordonnees (x, y) du centre de l'element trouve. Utile pour cliquer sur un bouton, lien, ou champ sans connaitre ses coordonnees.",
  {
    text: z.string().describe("Texte a chercher sur l'ecran (ex: 'Valider', 'Envoyer', 'Fichier')"),
  },
  async (args) => {
    const result = await agentRpc("screen.findText", { text: args.text });
    if (result.found) {
      return { content: [{ type: "text" as const, text: `Trouve: "${args.text}" a (${result.x}, ${result.y}) — confiance: ${result.confidence}%` }] };
    }
    return { content: [{ type: "text" as const, text: `Texte "${args.text}" non trouve sur l'ecran.` }] };
  },
);

server.tool(
  "rda_wait_for",
  "Attend qu'un texte apparaisse a l'ecran (polling OCR). Bloque jusqu'a ce que le texte soit detecte ou timeout. Ideal pour attendre le chargement d'une page, l'apparition d'un bouton, etc.",
  {
    text: z.string().describe("Texte a attendre"),
    timeout_ms: z.number().default(15000).describe("Timeout en ms (defaut: 15s)"),
    poll_ms: z.number().default(2000).describe("Intervalle de polling en ms (defaut: 2s)"),
  },
  async (args) => {
    const start = Date.now();
    while (Date.now() - start < args.timeout_ms) {
      try {
        const result = await agentRpc("screen.findText", { text: args.text });
        if (result.found) {
          return { content: [{ type: "text" as const, text: `Trouve: "${args.text}" a (${result.x}, ${result.y}) apres ${Date.now() - start}ms` }] };
        }
      } catch { /* retry */ }
      await new Promise(r => setTimeout(r, args.poll_ms));
    }
    return { content: [{ type: "text" as const, text: `Timeout: "${args.text}" non trouve apres ${args.timeout_ms}ms` }] };
  },
);

server.tool(
  "rda_detect_change",
  "Compare deux screenshots (base64) et detecte si l'ecran a change. Retourne le pourcentage de pixels differents. Utile pour verifier qu'une action a eu un effet visible.",
  {
    image_before: z.string().describe("Screenshot avant (base64 PNG)"),
    image_after: z.string().describe("Screenshot apres (base64 PNG)"),
  },
  async (args) => {
    const result = await agentRpc("screen.detectChange", { imageA: args.image_before, imageB: args.image_after });
    return {
      content: [{
        type: "text" as const,
        text: result.changed
          ? `Changement detecte: ${result.diffPercent}% de pixels differents.`
          : `Aucun changement significatif (${result.diffPercent}%).`,
      }],
    };
  },
);

// ═══════════════════════════════════════
// MODULE 2 — RDA FLOW (Orchestration)
// ═══════════════════════════════════════

server.tool(
  "rda_run_protocol",
  "Execute un protocole complet avec des variables. Charge le protocole par nom, substitue les parametres, et execute chaque etape sequentiellement avec verification visuelle optionnelle.",
  {
    protocol_name: z.string().describe("Nom ou ID du protocole a executer"),
    variables: z.record(z.string()).optional().describe("Variables a substituer dans les etapes (ex: {client: 'ACME', montant: '1500'})"),
    dry_run: z.boolean().default(false).describe("Si true, liste les etapes sans les executer"),
  },
  async (args) => {
    await ensureProtocolTable();
    const pool = getPool();
    const result = await pool.query(
      "SELECT * FROM formation_protocols WHERE (name = $1 OR id = $1) AND user_id = $2 LIMIT 1",
      [args.protocol_name, DEFAULT_USER_ID],
    );
    if (result.rows.length === 0) {
      return { content: [{ type: "text" as const, text: `Protocole "${args.protocol_name}" non trouve.` }] };
    }
    const proto = result.rows[0] as any;
    const steps = proto.steps as any[];
    const vars = args.variables || {};

    // Variable substitution helper
    const sub = (s: string) => {
      let out = s;
      for (const [k, v] of Object.entries(vars)) {
        out = out.replace(new RegExp(`\\$\\{${k}\\}|\\{\\{${k}\\}\\}`, "g"), v);
      }
      return out;
    };

    if (args.dry_run) {
      const plan = steps.map((s: any) =>
        `${s.id}. [${s.action}] ${sub(s.description || "")}`,
      ).join("\n");
      return { content: [{ type: "text" as const, text: `Plan (${steps.length} etapes):\n${plan}` }] };
    }

    const log: string[] = [];
    for (const step of steps) {
      const params = { ...step.params };
      // Substitute variables in text params
      if (params.text) params.text = sub(params.text as string);

      try {
        switch (step.action) {
          case "click":
            await agentRpc("screen.click", { x: params.x, y: params.y, type: params.click_type || "left" });
            break;
          case "type":
            await agentRpc("screen.pasteText", { text: params.text });
            break;
          case "keyPress":
            await agentRpc("screen.keyPress", { key: params.key });
            break;
          case "hotkey":
            await agentRpc("screen.hotkey", { keys: params.keys });
            break;
          case "scroll":
            await agentRpc("screen.scroll", { direction: params.direction, amount: params.amount || 3 });
            break;
          case "wait":
            await new Promise(r => setTimeout(r, (params.wait_ms as number) || 1000));
            break;
          case "find_and_click": {
            const found = await agentRpc("screen.findText", { text: sub(params.text as string) });
            if (found.found) {
              await agentRpc("screen.click", { x: found.x, y: found.y, type: "left" });
            } else {
              log.push(`⚠ Etape ${step.id}: "${params.text}" non trouve — skip`);
              continue;
            }
            break;
          }
          default:
            log.push(`⚠ Etape ${step.id}: action inconnue "${step.action}"`);
            continue;
        }
        log.push(`✓ Etape ${step.id}: ${step.description || step.action}`);
        // Small delay between steps
        await new Promise(r => setTimeout(r, step.timeout_ms || 500));
      } catch (err) {
        log.push(`✗ Etape ${step.id}: ERREUR — ${(err as Error).message}`);
        break;
      }
    }
    return { content: [{ type: "text" as const, text: `Protocole "${proto.name}" execute:\n${log.join("\n")}` }] };
  },
);

server.tool(
  "rda_conditional",
  "Execute une action conditionnelle: si un texte est visible a l'ecran, execute action_if, sinon execute action_else. Permet de gerer les cas ou l'ecran n'est pas dans l'etat attendu.",
  {
    condition_text: z.string().describe("Texte a chercher sur l'ecran"),
    action_if: z.object({
      action: z.string(),
      params: z.record(z.unknown()),
    }).describe("Action a executer si le texte est trouve"),
    action_else: z.object({
      action: z.string(),
      params: z.record(z.unknown()),
    }).optional().describe("Action a executer si le texte n'est PAS trouve"),
  },
  async (args) => {
    const found = await agentRpc("screen.findText", { text: args.condition_text });
    const chosen = found.found ? args.action_if : args.action_else;

    if (!chosen) {
      return { content: [{ type: "text" as const, text: `Condition: "${args.condition_text}" ${found.found ? "trouve" : "non trouve"} — aucune action alternative.` }] };
    }

    // Execute the chosen action
    const methodMap: Record<string, string> = {
      click: "screen.click",
      type: "screen.pasteText",
      keyPress: "screen.keyPress",
      hotkey: "screen.hotkey",
      scroll: "screen.scroll",
    };
    const method = methodMap[chosen.action];
    if (method) {
      await agentRpc(method, chosen.params);
    }
    return {
      content: [{
        type: "text" as const,
        text: `Condition "${args.condition_text}": ${found.found ? "VRAI" : "FAUX"} → action: ${chosen.action}`,
      }],
    };
  },
);

server.tool(
  "rda_loop",
  "Repete une sequence d'actions N fois, ou jusqu'a ce qu'un texte apparaisse/disparaisse de l'ecran. Utile pour traiter des listes, paginer, ou attendre un etat.",
  {
    max_iterations: z.number().default(10).describe("Nombre max d'iterations"),
    stop_when_text: z.string().optional().describe("Arreter quand ce texte apparait"),
    stop_when_gone: z.string().optional().describe("Arreter quand ce texte disparait"),
    steps: z.array(z.object({
      action: z.string(),
      params: z.record(z.unknown()),
    })).describe("Liste d'actions a repeter"),
  },
  async (args) => {
    const methodMap: Record<string, string> = {
      click: "screen.click",
      type: "screen.pasteText",
      keyPress: "screen.keyPress",
      hotkey: "screen.hotkey",
      scroll: "screen.scroll",
      wait: "",
    };

    let i = 0;
    for (; i < args.max_iterations; i++) {
      // Check stop conditions
      if (args.stop_when_text) {
        const found = await agentRpc("screen.findText", { text: args.stop_when_text });
        if (found.found) break;
      }
      if (args.stop_when_gone) {
        const found = await agentRpc("screen.findText", { text: args.stop_when_gone });
        if (!found.found) break;
      }

      // Execute steps
      for (const step of args.steps) {
        if (step.action === "wait") {
          await new Promise(r => setTimeout(r, (step.params.wait_ms as number) || 500));
        } else {
          const method = methodMap[step.action];
          if (method) await agentRpc(method, step.params);
        }
      }
      await new Promise(r => setTimeout(r, 300));
    }
    return { content: [{ type: "text" as const, text: `Boucle terminee apres ${i} iteration(s).` }] };
  },
);

// ═══════════════════════════════════════
// MODULE 3 — RDA INPUT (Entrees ameliorees)
// ═══════════════════════════════════════

server.tool(
  "rda_paste_text",
  "Colle du texte via le presse-papier (Ctrl+V). Contourne le probleme de mapping clavier AZERTY/QWERTY. C'est la methode recommandee pour taper du texte.",
  {
    text: z.string().describe("Texte a coller"),
  },
  async (args) => {
    await agentRpc("screen.pasteText", { text: args.text });
    return { content: [{ type: "text" as const, text: `Colle: "${args.text.substring(0, 80)}${args.text.length > 80 ? "..." : ""}"` }] };
  },
);

server.tool(
  "rda_drag_drop",
  "Glisser-deposer d'un point A vers un point B sur l'ecran.",
  {
    from_x: z.number().describe("X de depart"),
    from_y: z.number().describe("Y de depart"),
    to_x: z.number().describe("X de destination"),
    to_y: z.number().describe("Y de destination"),
  },
  async (args) => {
    await agentRpc("screen.drag", { x1: args.from_x, y1: args.from_y, x2: args.to_x, y2: args.to_y });
    return { content: [{ type: "text" as const, text: `Drag: (${args.from_x},${args.from_y}) → (${args.to_x},${args.to_y})` }] };
  },
);

server.tool(
  "rda_fill_form",
  "Remplit un formulaire en trouvant chaque champ par son label (OCR), puis en tapant la valeur. Utilise Tab pour passer au champ suivant si le clic echoue.",
  {
    fields: z.array(z.object({
      label: z.string().describe("Label du champ (texte visible pres du champ)"),
      value: z.string().describe("Valeur a saisir"),
      offset_x: z.number().default(150).describe("Decalage X depuis le label vers le champ (defaut: 150px a droite)"),
      offset_y: z.number().default(0).describe("Decalage Y depuis le label vers le champ"),
    })).describe("Liste des champs a remplir"),
  },
  async (args) => {
    const results: string[] = [];
    for (const field of args.fields) {
      const found = await agentRpc("screen.findText", { text: field.label });
      if (found.found) {
        // Click on the input field (offset from label)
        await agentRpc("screen.click", { x: found.x + field.offset_x, y: found.y + field.offset_y, type: "left" });
        await new Promise(r => setTimeout(r, 200));
        // Select all existing text then paste new value
        await agentRpc("screen.hotkey", { keys: ["ctrl", "a"] });
        await new Promise(r => setTimeout(r, 100));
        await agentRpc("screen.pasteText", { text: field.value });
        results.push(`✓ ${field.label}: "${field.value}"`);
      } else {
        results.push(`✗ ${field.label}: label non trouve`);
      }
      await new Promise(r => setTimeout(r, 300));
    }
    return { content: [{ type: "text" as const, text: `Formulaire:\n${results.join("\n")}` }] };
  },
);

server.tool(
  "rda_click_text",
  "Trouve un texte a l'ecran par OCR et clique dessus. Combine rda_find_element + clic en une seule action.",
  {
    text: z.string().describe("Texte a trouver et cliquer"),
    click_type: z.enum(["left", "right", "double"]).default("left").describe("Type de clic"),
    offset_x: z.number().default(0).describe("Decalage X depuis le centre du texte"),
    offset_y: z.number().default(0).describe("Decalage Y depuis le centre du texte"),
  },
  async (args) => {
    const found = await agentRpc("screen.findText", { text: args.text });
    if (!found.found) {
      return { content: [{ type: "text" as const, text: `Texte "${args.text}" non trouve sur l'ecran.` }] };
    }
    await agentRpc("screen.click", {
      x: found.x + args.offset_x,
      y: found.y + args.offset_y,
      type: args.click_type,
    });
    return { content: [{ type: "text" as const, text: `Clique sur "${args.text}" a (${found.x + args.offset_x}, ${found.y + args.offset_y})` }] };
  },
);

// ═══════════════════════════════════════
// MODULE 4 — RDA WINDOW (Gestion fenetres)
// ═══════════════════════════════════════

server.tool(
  "rda_list_windows",
  "Liste toutes les fenetres ouvertes sur le bureau. Retourne l'ID, le titre et le PID de chaque fenetre.",
  {},
  async () => {
    await ensureDesktopReady("rda_list_windows");
    const result = await agentRpc("screen.listWindows");
    if (!result.windows || result.windows.length === 0) {
      return { content: [{ type: "text" as const, text: "Aucune fenetre detectee." }] };
    }
    const list = result.windows.map((w: any) =>
      `- [${w.id}] "${w.title}" (PID: ${w.pid})`,
    ).join("\n");
    return { content: [{ type: "text" as const, text: `${result.windows.length} fenetre(s):\n${list}` }] };
  },
);

server.tool(
  "rda_focus_window",
  "Met le focus sur une fenetre par son titre (ou partie du titre). La fenetre passe au premier plan.",
  {
    title: z.string().describe("Titre (ou partie du titre) de la fenetre a activer"),
  },
  async (args) => {
    const result = await agentRpc("screen.focusWindow", { title: args.title });
    return {
      content: [{
        type: "text" as const,
        text: result.ok ? `Fenetre "${args.title}" activee.` : `Fenetre "${args.title}" non trouvee.`,
      }],
    };
  },
);

server.tool(
  "rda_resize_window",
  "Deplace et redimensionne la fenetre active.",
  {
    x: z.number().describe("Position X de la fenetre"),
    y: z.number().describe("Position Y de la fenetre"),
    width: z.number().describe("Largeur"),
    height: z.number().describe("Hauteur"),
  },
  async (args) => {
    await agentRpc("screen.resizeWindow", { x: args.x, y: args.y, w: args.width, h: args.height });
    return { content: [{ type: "text" as const, text: `Fenetre repositionnee: (${args.x},${args.y}) ${args.width}x${args.height}` }] };
  },
);

// ═══════════════════════════════════════
// MODULE 5 — RDA DATA (Extraction)
// ═══════════════════════════════════════

server.tool(
  "rda_scrape_region",
  "Extrait le texte d'une zone precise de l'ecran via OCR. Utile pour lire des tableaux, des valeurs, des messages d'erreur, etc.",
  {
    x: z.number().describe("X du coin haut-gauche"),
    y: z.number().describe("Y du coin haut-gauche"),
    width: z.number().describe("Largeur de la zone"),
    height: z.number().describe("Hauteur de la zone"),
  },
  async (args) => {
    const result = await agentRpc("screen.readText", {
      region: { x: args.x, y: args.y, w: args.width, h: args.height },
    });
    return { content: [{ type: "text" as const, text: result.text || "(zone vide)" }] };
  },
);

server.tool(
  "rda_clipboard_read",
  "Lit le contenu actuel du presse-papier.",
  {},
  async () => {
    const result = await agentRpc("screen.getClipboard");
    return { content: [{ type: "text" as const, text: result.text || "(presse-papier vide)" }] };
  },
);

server.tool(
  "rda_clipboard_write",
  "Ecrit du texte dans le presse-papier sans le coller.",
  {
    text: z.string().describe("Texte a mettre dans le presse-papier"),
  },
  async (args) => {
    await agentRpc("screen.setClipboard", { text: args.text });
    return { content: [{ type: "text" as const, text: `Presse-papier mis a jour (${args.text.length} chars).` }] };
  },
);

server.tool(
  "rda_monitor_region",
  "Surveille une zone de l'ecran et detecte tout changement. Prend deux screenshots espaces dans le temps et compare.",
  {
    x: z.number().describe("X du coin haut-gauche"),
    y: z.number().describe("Y du coin haut-gauche"),
    width: z.number().describe("Largeur"),
    height: z.number().describe("Hauteur"),
    delay_ms: z.number().default(3000).describe("Delai entre les deux captures (defaut: 3s)"),
  },
  async (args) => {
    const region = { x: args.x, y: args.y, w: args.width, h: args.height };
    const before = await agentRpc("screen.screenshot", { region });
    await new Promise(r => setTimeout(r, args.delay_ms));
    const after = await agentRpc("screen.screenshot", { region });
    const diff = await agentRpc("screen.detectChange", { imageA: before.image, imageB: after.image });
    return {
      content: [{
        type: "text" as const,
        text: diff.changed
          ? `Changement detecte dans la zone (${diff.diffPercent}% different).`
          : `Aucun changement dans la zone apres ${args.delay_ms}ms.`,
      }],
    };
  },
);


// ═══════════════════════════════════════
// HEALTHCHECK
// ═══════════════════════════════════════

server.tool(
  "formation_healthcheck",
  "Diagnostic complet du desktop local: verifie DISPLAY, outils (xdotool, scrot, wmctrl, xclip, tesseract, imagemagick), et teste un screenshot reel. Retourne un rapport detaille avec fixHint pour chaque probleme.",
  {},
  async () => {
    try {
      const health = await agentRpc("agent.health");
      const checks = (health.checks || []) as Array<{ name: string; ok: boolean; details: string; fixHint?: string }>;
      const lines = checks.map((c: any) => {
        const status = c.ok ? "✓" : "✗";
        const hint = c.fixHint ? ` → ${c.fixHint}` : "";
        return `${status} ${c.name}: ${c.details}${hint}`;
      });
      const env = health.environment || {};
      const envLines = [
        `DISPLAY: ${env.display || "non defini"}`,
        `WAYLAND: ${env.waylandDisplay || "non defini"}`,
        `XDG_SESSION_TYPE: ${env.xdgSessionType || "non defini"}`,
        `Desktop available: ${env.desktopAvailable ? "oui" : "NON"}`,
      ];
      return {
        content: [{
          type: "text" as const,
          text: `## Healthcheck Desktop Agent\n\n**Resultat: ${health.ok ? "OK ✓" : "PROBLEMES DETECTES ✗"}**\n\n${health.summary}\n\n### Environnement\n${envLines.join("\n")}\n\n### Checks\n${lines.join("\n")}`,
        }],
      };
    } catch (err) {
      const info = await getAgentCapabilities();
      return {
        content: [{
          type: "text" as const,
          text: `## Healthcheck Desktop Agent — ERREUR\n\nImpossible d'executer le healthcheck.\nAgent version: ${info.agentVersion}, protocole: ${info.protocolVersion}\n\n${info.protocolVersion === "0" ? "L'agent ne supporte pas agent.health. Mettez a jour l'agent." : (err as Error).message}`,
        }],
      };
    }
  },
);

// ─── Start ───

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[ubik-formation] Fatal:", err);
  process.exit(1);
});
