#!/usr/bin/env node
/**
 * Standalone MCP server — crawl.ts
 *
 * Tools:
 *   - crawl_url           Fetch a web page via Puppeteer, return clean markdown.
 *   - extract_structured  Fetch a page, run user-defined CSS selectors, return JSON.
 *
 * No UBIK-RELEASE deps. Imports: @modelcontextprotocol/sdk, zod, dotenv, puppeteer, node:*.
 * Pattern: createMcpServer + runServer from src/lib/server.ts.
 */

import { z } from "zod";
import { config } from "dotenv";
import path from "node:path";
import { createMcpServer, runServer } from "../lib/server";

config({ path: path.join(process.cwd(), ".env") });

const MAX_CONTENT_LENGTH = 80_000;
const DEFAULT_TIMEOUT = 30_000;

// ── HTML → Markdown (compact converter) ──────────────────────────────────────
function htmlToMarkdown(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  for (let i = 1; i <= 6; i++) {
    s = s.replace(new RegExp(`<h${i}[^>]*>([\\s\\S]*?)</h${i}>`, "gi"), `\n${"#".repeat(i)} $1\n`);
  }
  s = s.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  s = s.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, "![$2]($1)");
  s = s.replace(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>/gi, "![$1]($2)");
  s = s.replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, "![]($1)");
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
  s = s.replace(/<\/?[ou]l[^>]*>/gi, "\n");
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, "> $1\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n");
  s = s.replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, "\n$1\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)));
  return s
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Puppeteer page fetch ─────────────────────────────────────────────────────
async function fetchPage(
  url: string,
  options: { waitFor?: string; timeout?: number; javascript?: boolean } = {},
): Promise<{ html: string; title: string; finalUrl: string }> {
  const puppeteer = await import("puppeteer");
  const browser = await puppeteer.default.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent("UBIK-MCP-Crawl/1.0");
    await page.setViewport({ width: 1280, height: 720 });
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const t = req.resourceType();
      if (["image", "media", "font", "stylesheet"].includes(t)) req.abort();
      else req.continue();
    });
    await page.goto(url, {
      waitUntil: options.javascript === false ? "domcontentloaded" : "networkidle2",
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
    });
    if (options.waitFor) {
      await page.waitForSelector(options.waitFor, { timeout: 5_000 }).catch(() => {});
    }
    const title = await page.title();
    const html = await page.content();
    return { html, title, finalUrl: page.url() };
  } finally {
    await browser.close();
  }
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = createMcpServer("ubik-crawl-standalone");

server.tool(
  "crawl_url",
  "Fetch a web page and return its main content as clean markdown. Strips nav/scripts/style. Truncates at ~80KB.",
  {
    url: z.string().url().describe("URL to crawl"),
    wait_for: z.string().optional().describe("CSS selector to wait for before extracting"),
    javascript: z.boolean().optional().describe("Execute page JS before extracting (default: true)"),
  },
  async ({ url, wait_for, javascript }) => {
    try {
      const { html, title, finalUrl } = await fetchPage(url, { waitFor: wait_for, javascript });
      let md = htmlToMarkdown(html);
      if (md.length > MAX_CONTENT_LENGTH) {
        md = md.slice(0, MAX_CONTENT_LENGTH) + "\n\n[... truncated at 80KB ...]";
      }
      const out = `# ${title}\n\n**Source:** ${finalUrl}\n\n---\n\n${md}`;
      return { content: [{ type: "text" as const, text: out }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error crawling ${url}: ${msg}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "extract_structured",
  "Fetch a page and extract structured data via user-defined CSS selectors. Returns a JSON object keyed by field name.",
  {
    url: z.string().url().describe("URL to extract from"),
    fields: z
      .array(
        z.object({
          name: z.string().describe("Field key in the returned JSON"),
          selector: z.string().describe("CSS selector to match"),
          attribute: z.string().optional().describe("HTML attribute to read (default: text)"),
          multiple: z.boolean().optional().describe("Return array of all matches (default: first only)"),
        }),
      )
      .describe("Fields to extract"),
    wait_for: z.string().optional().describe("CSS selector to wait for before extracting"),
  },
  async ({ url, fields, wait_for }) => {
    try {
      const puppeteer = await import("puppeteer");
      const browser = await puppeteer.default.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      });
      try {
        const page = await browser.newPage();
        await page.setUserAgent("UBIK-MCP-Crawl/1.0");
        await page.goto(url, { waitUntil: "networkidle2", timeout: DEFAULT_TIMEOUT });
        if (wait_for) {
          await page.waitForSelector(wait_for, { timeout: 5_000 }).catch(() => {});
        }
        const out: Record<string, unknown> = { _source: url };
        for (const f of fields) {
          if (f.multiple) {
            out[f.name] = await page.$$eval(
              f.selector,
              (els, attr) =>
                els.map((el) =>
                  attr ? el.getAttribute(attr) || "" : (el.textContent || "").trim(),
                ),
              f.attribute || "",
            );
          } else {
            out[f.name] = await page
              .$eval(
                f.selector,
                (el, attr) =>
                  attr ? el.getAttribute(attr) || "" : (el.textContent || "").trim(),
                f.attribute || "",
              )
              .catch(() => null);
          }
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
      } finally {
        await browser.close();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error extracting from ${url}: ${msg}` }],
        isError: true,
      };
    }
  },
);

runServer(server).catch((err) => {
  process.stderr.write(`[ubik-crawl-standalone] fatal: ${String(err)}\n`);
  process.exit(1);
});
