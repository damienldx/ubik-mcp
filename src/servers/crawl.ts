#!/usr/bin/env node
/**
 * crawl MCP server — Puppeteer-backed page fetching and structured extraction.
 *
 * Tools (2):
 *   - crawl_fetch_page         Fetches a web page and returns its main content as clean markdown.
 *   - crawl_extract_fields     Fetches a page and extracts structured data via CSS selectors.
 *
 * Imports: @modelcontextprotocol/sdk, zod, dotenv, puppeteer, node:* only.
 */

import { z } from "zod";
import { config } from "dotenv";
import path from "node:path";
import { createMcpServer, runServer } from "../lib/server.js";

config({ path: path.join(process.cwd(), ".env") });

const MAX_CONTENT_LENGTH = 80_000;
const DEFAULT_TIMEOUT = 30_000;

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

const server = createMcpServer("ubik-crawl");

server.tool(
  "crawl_fetch_page",
  "Fetches a web page via Puppeteer and returns its main content as clean markdown. Strips nav, scripts, and styles; truncates at 80KB.",
  {
    url:        z.string().url().describe("URL to fetch"),
    wait_for:   z.string().optional().describe("CSS selector to wait for before extracting"),
    javascript: z.boolean().optional().describe("Execute page JavaScript before extracting (default true)"),
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
  "crawl_extract_fields",
  "Fetches a web page and extracts structured data via user-defined CSS selectors. Returns a JSON object keyed by field name.",
  {
    url: z.string().url().describe("URL to fetch and extract from"),
    fields: z
      .array(
        z.object({
          name:      z.string().describe("Field key in the returned JSON"),
          selector:  z.string().describe("CSS selector to match"),
          attribute: z.string().optional().describe("HTML attribute to read (default: text content)"),
          multiple:  z.boolean().optional().describe("Return array of all matches instead of the first (default false)"),
        }),
      )
      .describe("Field definitions to extract from the page"),
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

// ─── New tools (issue #14 enrich) ────────────────────────────────────────────

server.tool(
  "crawl_get_links",
  "Fetch a web page and return all links it contains (text + href). Optionally filter by URL substring.",
  {
    url:        z.string().url().describe("URL to fetch"),
    contains:   z.string().optional().describe("Only return links whose href contains this substring"),
    same_origin: z.boolean().optional().describe("If true, only return links on the same origin as the URL"),
    wait_for:   z.string().optional().describe("CSS selector to wait for before extracting"),
  },
  async ({ url, contains, same_origin, wait_for }) => {
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
        if (wait_for) await page.waitForSelector(wait_for, { timeout: 5_000 }).catch(() => {});
        const links = await page.$$eval("a[href]", (els) =>
          els.map((el) => ({
            text: (el.textContent || "").trim(),
            href: (el as HTMLAnchorElement).href,
          })),
        );
        const origin = new URL(url).origin;
        const filtered = links.filter((l) => {
          if (!l.href) return false;
          if (contains && !l.href.includes(contains)) return false;
          if (same_origin) {
            try { if (new URL(l.href).origin !== origin) return false; } catch { return false; }
          }
          return true;
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ url, count: filtered.length, links: filtered }, null, 2) }] };
      } finally {
        await browser.close();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Error getting links from ${url}: ${msg}` }], isError: true };
    }
  },
);

server.tool(
  "crawl_get_text",
  "Fetch a web page and return its visible text content as plain text (no markdown, no HTML). Useful for downstream NLP.",
  {
    url:      z.string().url().describe("URL to fetch"),
    wait_for: z.string().optional().describe("CSS selector to wait for before extracting"),
  },
  async ({ url, wait_for }) => {
    try {
      const { html, title, finalUrl } = await fetchPage(url, { waitFor: wait_for });
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const truncated = text.length > MAX_CONTENT_LENGTH
        ? text.slice(0, MAX_CONTENT_LENGTH) + " [... truncated ...]"
        : text;
      return { content: [{ type: "text" as const, text: `# ${title}\nSource: ${finalUrl}\n\n${truncated}` }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Error getting text from ${url}: ${msg}` }], isError: true };
    }
  },
);

server.tool(
  "crawl_get_metadata",
  "Fetch a web page and return its metadata: title, description, canonical URL, language, OpenGraph tags, Twitter card tags.",
  {
    url: z.string().url().describe("URL to fetch"),
  },
  async ({ url }) => {
    try {
      const puppeteer = await import("puppeteer");
      const browser = await puppeteer.default.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      });
      try {
        const page = await browser.newPage();
        await page.setUserAgent("UBIK-MCP-Crawl/1.0");
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
        const meta = await page.evaluate(() => {
          const get = (sel: string, attr = "content"): string =>
            document.querySelector(sel)?.getAttribute(attr) ?? "";
          const allMeta: Record<string, string> = {};
          document.querySelectorAll<HTMLMetaElement>('meta[property^="og:"], meta[name^="og:"]').forEach((m) => {
            const k = m.getAttribute("property") || m.getAttribute("name") || "";
            if (k) allMeta[k] = m.content || "";
          });
          document.querySelectorAll<HTMLMetaElement>('meta[name^="twitter:"]').forEach((m) => {
            const k = m.getAttribute("name") || "";
            if (k) allMeta[k] = m.content || "";
          });
          return {
            title:       document.title,
            description: get('meta[name="description"]'),
            canonical:   get('link[rel="canonical"]', "href"),
            language:    document.documentElement.lang || "",
            charset:     document.characterSet || "",
            ...allMeta,
          };
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ url, metadata: meta }, null, 2) }] };
      } finally {
        await browser.close();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Error getting metadata from ${url}: ${msg}` }], isError: true };
    }
  },
);

server.tool(
  "crawl_check_status",
  "Send a HEAD request to a URL and return the HTTP status, redirect chain, and key response headers. Lightweight (no JS execution).",
  {
    url:           z.string().url().describe("URL to check"),
    follow_redirects: z.boolean().optional().describe("Follow redirects to the final URL (default true)"),
    timeout_ms:    z.number().int().positive().max(30_000).optional().describe("Timeout in ms (default 10000)"),
  },
  async ({ url, follow_redirects, timeout_ms }) => {
    try {
      const ctrl    = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), timeout_ms ?? 10_000);
      const res = await fetch(url, {
        method:   "HEAD",
        redirect: follow_redirects === false ? "manual" : "follow",
        signal:   ctrl.signal,
      });
      clearTimeout(timeout);
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      return { content: [{ type: "text" as const, text: JSON.stringify({
        url,
        final_url:    res.url,
        status:       res.status,
        status_text:  res.statusText,
        ok:           res.ok,
        redirected:   res.redirected,
        content_type: headers["content-type"] || null,
        headers,
      }, null, 2) }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Error checking ${url}: ${msg}` }], isError: true };
    }
  },
);

server.tool(
  "crawl_search_web",
  "Search the web via DuckDuckGo (HTML endpoint, no API key). Returns a list of {title, url, snippet} results.",
  {
    query:       z.string().describe("Search query"),
    max_results: z.number().int().positive().max(30).default(10).describe("Maximum results to return"),
    region:      z.string().optional().describe("Optional region code (e.g. 'fr-fr', 'us-en'). Defaults to no region."),
  },
  async ({ query, max_results, region }) => {
    try {
      const params = new URLSearchParams({ q: query });
      if (region) params.set("kl", region);
      const ddgUrl = `https://html.duckduckgo.com/html/?${params.toString()}`;
      const res = await fetch(ddgUrl, {
        method: "POST",
        headers: { "User-Agent": "UBIK-MCP-Crawl/1.0", "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      if (!res.ok) {
        return { content: [{ type: "text" as const, text: `DuckDuckGo HTTP ${res.status}` }], isError: true };
      }
      const html = await res.text();
      // DuckDuckGo HTML structure: results in <div class="result"> with .result__title a, .result__snippet
      const results: { title: string; url: string; snippet: string }[] = [];
      const blockRe = /<div class="result\b[^"]*"[\s\S]*?<\/div>\s*<\/div>/gi;
      const titleRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
      const snipRe  = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i;
      const strip   = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      let m: RegExpExecArray | null;
      while ((m = blockRe.exec(html)) && results.length < max_results) {
        const block = m[0];
        const t     = block.match(titleRe);
        const s     = block.match(snipRe);
        if (t) {
          // DuckDuckGo wraps URLs in /l/?uddg=<encoded>
          let href = t[1];
          const u = new URL(href, "https://duckduckgo.com");
          const real = u.searchParams.get("uddg");
          if (real) href = decodeURIComponent(real);
          results.push({
            title:   strip(t[2]),
            url:     href,
            snippet: s ? strip(s[1]) : "",
          });
        }
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ query, count: results.length, results }, null, 2) }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Search error: ${msg}` }], isError: true };
    }
  },
);

server.tool(
  "crawl_submit_form",
  "Submit an HTML form via POST and return the response body. Form fields are sent as application/x-www-form-urlencoded by default.",
  {
    url:          z.string().url().describe("Form action URL (where to POST)"),
    fields:       z.record(z.string()).describe("Form field name → value pairs"),
    content_type: z.enum(["application/x-www-form-urlencoded", "multipart/form-data", "application/json"])
                   .default("application/x-www-form-urlencoded")
                   .describe("Body encoding"),
    headers:      z.record(z.string()).optional().describe("Additional HTTP headers"),
    timeout_ms:   z.number().int().positive().max(60_000).optional().describe("Timeout in ms (default 30000)"),
  },
  async ({ url, fields, content_type, headers, timeout_ms }) => {
    try {
      const ctrl    = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), timeout_ms ?? 30_000);
      let body: BodyInit;
      const reqHeaders: Record<string, string> = {
        "User-Agent":   "UBIK-MCP-Crawl/1.0",
        "Content-Type": content_type,
        ...(headers ?? {}),
      };
      if (content_type === "application/json") {
        body = JSON.stringify(fields);
      } else if (content_type === "multipart/form-data") {
        const fd = new FormData();
        for (const [k, v] of Object.entries(fields)) fd.append(k, v);
        body = fd;
        // Browser sets boundary automatically when body is FormData; remove our manual header.
        delete reqHeaders["Content-Type"];
      } else {
        body = new URLSearchParams(fields).toString();
      }
      const res = await fetch(url, {
        method:  "POST",
        headers: reqHeaders,
        body,
        signal:  ctrl.signal,
      });
      clearTimeout(timeout);
      const text = await res.text();
      return { content: [{ type: "text" as const, text: JSON.stringify({
        url,
        status: res.status,
        ok: res.ok,
        body: text.length > MAX_CONTENT_LENGTH ? text.slice(0, MAX_CONTENT_LENGTH) + " [...truncated]" : text,
      }, null, 2) }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Form submit error: ${msg}` }], isError: true };
    }
  },
);

server.tool(
  "crawl_follow_redirect",
  "Manually follow HTTP redirects from a URL and return the full chain (status + Location at each hop). Stops at first non-redirect response or max_hops.",
  {
    url:      z.string().url().describe("Starting URL"),
    max_hops: z.number().int().positive().max(20).default(10).describe("Maximum redirects to follow before stopping"),
  },
  async ({ url, max_hops }) => {
    const chain: { hop: number; url: string; status: number; location?: string }[] = [];
    let current = url;
    for (let hop = 0; hop < max_hops; hop++) {
      try {
        const res = await fetch(current, { method: "HEAD", redirect: "manual" });
        const loc = res.headers.get("location") || undefined;
        const link = loc ? new URL(loc, current).toString() : undefined;
        chain.push({ hop, url: current, status: res.status, location: link });
        if (!link || res.status < 300 || res.status >= 400) break;
        current = link;
      } catch (err) {
        chain.push({ hop, url: current, status: 0, location: `error: ${err instanceof Error ? err.message : String(err)}` });
        break;
      }
    }
    return { content: [{ type: "text" as const, text: JSON.stringify({ start: url, hops: chain.length, chain }, null, 2) }] };
  },
);

runServer(server).catch((err) => {
  process.stderr.write(`[ubik-crawl] fatal: ${String(err)}\n`);
  process.exit(1);
});
