#!/usr/bin/env node
/**
 * UBIK LBA Backend Proxy — MCP stdio server proxying LBA :8504 REST API.
 *
 * Exposes 4 LBA agent-manifest tools via stdio MCP, routed through
 * POST http://127.0.0.1:8504/api/tools/{name}.
 *
 * Schemas are loaded statically (sourced from the engine DB on 2026-05-28).
 * If LBA gains new MCP tools, update the SCHEMAS constant.
 *
 * Why a proxy: lets the ubik-mcp gateway aggregate LBA tools alongside the
 * other servers, so MCP clients (Claude/Gemini/Codex/fleet) only declare
 * one upstream and reach the whole arsenal.
 */

import { z } from "zod";
import { createMcpServer, runServer } from "../lib/server.js";

const LBA_BASE = process.env.LBA_BACKEND_URL || "http://127.0.0.1:8504";

type Schema = {
  name: string;
  description: string;
  zodSchema: z.ZodTypeAny;
};

const SCHEMAS: Schema[] = [
  {
    name: "manifest_list",
    description:
      "Liste tous les manifests d'agents LBA disponibles (id, name, level, role, domain, version). A appeler EN PREMIER pour decouvrir les agent_id valides avant manifest_read/validate/write. Lecture seule, aucun argument.",
    zodSchema: z.object({}),
  },
  {
    name: "manifest_read",
    description:
      "Lit le manifest actuel d'un agent LBA (frontmatter structure + body). Toujours appeler en premier pour connaitre l'etat actuel.",
    zodSchema: z.object({
      agent_id: z.string().describe("Identifiant de l'agent (ex: lba-chef-ventes)"),
    }),
  },
  {
    name: "manifest_validate",
    description:
      "Valide le manifest d'un agent contre la spec LBA. Retourne la liste des anomalies : champs manquants, H1 incoherent, version mal formatee, schema invalide.",
    zodSchema: z.object({
      agent_id: z.string().describe("Identifiant de l'agent"),
    }),
  },
  {
    name: "manifest_write_body",
    description:
      "Remplace integralement le body (system prompt Markdown) d'un agent. Ecrit dans une copie de travail — ne touche pas au fichier reel avant confirmation.",
    zodSchema: z.object({
      agent_id: z.string().describe("Identifiant de l'agent"),
      body: z.string().describe("Nouveau contenu complet du body Markdown"),
    }),
  },
  {
    name: "manifest_write_field",
    description:
      "Modifie un champ du frontmatter d'un agent (name, level, role, version, description, autonomy, domain, memory, id). Ecrit dans une copie de travail.",
    zodSchema: z.object({
      agent_id: z.string().describe("Identifiant de l'agent"),
      field: z.string().describe("Nom du champ frontmatter a modifier"),
      value: z.any().describe("Nouvelle valeur du champ"),
    }),
  },
];

async function callBackend(name: string, args: Record<string, unknown>): Promise<unknown> {
  const url = `${LBA_BASE}/api/tools/${name}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`LBA ${name} HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

const server = createMcpServer("ubik-lba-backend");

for (const s of SCHEMAS) {
  server.tool(
    s.name,
    s.description,
    (s.zodSchema as z.ZodObject<z.ZodRawShape>).shape,
    async (args: Record<string, unknown>) => {
      try {
        const result = await callBackend(s.name, args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err?.message ?? String(err)}` }],
          isError: true,
        };
      }
    },
  );
}

runServer(server).catch((err) => {
  process.stderr.write(`[ubik-lba-backend] fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
