#!/usr/bin/env node
/**
 * UBIK Crawl — MCP Server (stdio transport)
 *
 * LLM-optimized web crawling: converts web pages to clean markdown,
 * extracts structured data, and crawls multi-page sites.
 *
 * Inspired by Firecrawl (AGPL) & Crawl4AI (MIT) — built from scratch
 * using Puppeteer (already in UBIK) for zero new dependencies.
 *
 * Tools:
 *   - crawl_url        → Convert a single URL to clean LLM-friendly markdown
 *   - crawl_site       → Multi-page crawl with depth control
 *   - crawl_extract    → Structured extraction with a user-defined schema
 *   - crawl_search     → Search the web and convert top results to markdown
 *   - crawl_map        → Discover all URLs on a site (sitemap)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "dotenv";
import path from "node:path";
import { createMcpAuth, wrapTransportWithAuth } from "../lib/mcp-auth";

config({ path: path.join(process.cwd(), ".env") });

const auth = createMcpAuth("ubik-crawl");

const UBIK_API = process.env.UBIK_API_URL || process.env.UBIK_BASE_URL || "http://localhost:3001";
const MAX_CONTENT_LENGTH = 80000; // ~80KB max per page to stay within LLM context
const DEFAULT_TIMEOUT = 30000;

// ─── HTML to Markdown converter ───

function htmlToMarkdown(html: string): string {
  // Remove script, style, nav, footer, header noise
  let clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "");

  // Convert headings
  clean = clean.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  clean = clean.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  clean = clean.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  clean = clean.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
  clean = clean.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n");
  clean = clean.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n");

  // Convert links
  clean = clean.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");

  // Convert images
  clean = clean.replace(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>/gi, "![$1]($2)");
  clean = clean.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, "![$2]($1)");
  clean = clean.replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, "![]($1)");

  // Convert bold/italic
  clean = clean.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  clean = clean.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");

  // Convert code
  clean = clean.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  clean = clean.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");

  // Convert lists
  clean = clean.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
  clean = clean.replace(/<\/?[ou]l[^>]*>/gi, "\n");

  // Convert blockquotes
  clean = clean.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, "> $1\n");

  // Convert tables
  clean = clean.replace(/<table[\s\S]*?<\/table>/gi, (table) => {
    const rows: string[][] = [];
    const rowMatches = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const row of rowMatches) {
      const cells: string[] = [];
      const cellMatches = row.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || [];
      for (const cell of cellMatches) {
        const text = cell.replace(/<[^>]+>/g, "").trim();
        cells.push(text);
      }
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return "";

    const maxCols = Math.max(...rows.map((r) => r.length));
    const header = rows[0];
    const separator = header.map(() => "---");
    const body = rows.slice(1);

    let md = "\n| " + header.join(" | ") + " |\n";
    md += "| " + separator.join(" | ") + " |\n";
    for (const row of body) {
      while (row.length < maxCols) row.push("");
      md += "| " + row.join(" | ") + " |\n";
    }
    return md;
  });

  // Convert paragraphs and line breaks
  clean = clean.replace(/<br\s*\/?>/gi, "\n");
  clean = clean.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n");
  clean = clean.replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, "\n$1\n");

  // Strip remaining HTML tags
  clean = clean.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  clean = clean
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));

  // Clean up whitespace
  clean = clean
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return clean;
}

// ─── Extract all links from HTML ───

function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const regex = /href="([^"#]*?)"/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const resolved = new URL(match[1], baseUrl).href;
      if (resolved.startsWith("http")) links.push(resolved);
    } catch { /* skip invalid URLs */ }
  }
  return [...new Set(links)];
}

// ─── Puppeteer page fetch ───

async function fetchPage(url: string, options: {
  waitFor?: string;
  timeout?: number;
  javascript?: boolean;
} = {}): Promise<{ html: string; title: string; url: string }> {
  const puppeteer = await import("puppeteer");
  const browser = await puppeteer.default.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent("UBIK-Crawl/1.0 (AI IDE Web Crawler)");
    await page.setViewport({ width: 1280, height: 720 });

    // Block heavy resources for speed
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (["image", "media", "font", "stylesheet"].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(url, {
      waitUntil: options.javascript !== false ? "networkidle2" : "domcontentloaded",
      timeout: options.timeout || DEFAULT_TIMEOUT,
    });

    if (options.waitFor) {
      await page.waitForSelector(options.waitFor, { timeout: 5000 }).catch(() => {});
    }

    const title = await page.title();
    const html = await page.content();
    const finalUrl = page.url();

    return { html, title, url: finalUrl };
  } finally {
    await browser.close();
  }
}

// ─── Save to Cortex (optional) ───

async function saveToCortex(title: string, content: string, url: string): Promise<void> {
  try {
    await fetch(`${UBIK_API}/api/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth.getAuthHeaders() },
      body: JSON.stringify({
        layer: "archive",
        action: "create",
        type: "observation",
        source: "ubik-crawl",
        title: `Crawl: ${title}`,
        content: content.substring(0, 10000),
        tags: ["crawl", "web", new URL(url).hostname],
      }),
    });
  } catch { /* non-critical */ }
}

// ═══════════════════════════════════════
// MCP Server
// ═══════════════════════════════════════

const server = new McpServer({
  name: "ubik-crawl",
  version: "1.0.0",
});

// ─── Tool: crawl_url ───

server.tool(
  "crawl_url",
  "Convert a web page to clean LLM-friendly markdown. Strips navigation, ads, scripts. Returns the main content as structured markdown with headings, links, tables preserved.",
  {
    url: z.string().url().describe("The URL to crawl"),
    wait_for: z.string().optional().describe("CSS selector to wait for before extracting (for JS-heavy pages)"),
    save_to_cortex: z.boolean().optional().describe("Save result to Cortex Archive (default: false)"),
    include_links: z.boolean().optional().describe("Include a list of all links found on the page (default: false)"),
  },
  async ({ url, wait_for, save_to_cortex: saveCortex, include_links }) => {
    try {
      const { html, title, url: finalUrl } = await fetchPage(url, { waitFor: wait_for });
      let markdown = htmlToMarkdown(html);

      // Truncate if too long
      if (markdown.length > MAX_CONTENT_LENGTH) {
        markdown = markdown.substring(0, MAX_CONTENT_LENGTH) + "\n\n[... content truncated at 80KB ...]";
      }

      // Build output
      let output = `# ${title}\n\n**Source:** ${finalUrl}\n\n---\n\n${markdown}`;

      if (include_links) {
        const links = extractLinks(html, finalUrl);
        output += `\n\n---\n\n## Links found (${links.length})\n\n`;
        output += links.slice(0, 100).map((l) => `- ${l}`).join("\n");
        if (links.length > 100) output += `\n- ... and ${links.length - 100} more`;
      }

      if (saveCortex) {
        await saveToCortex(title, markdown, finalUrl);
        output += "\n\n*Saved to Cortex Archive.*";
      }

      return { content: [{ type: "text" as const, text: output }] };
    } catch (err: any) {
      const safeMsg = (err?.message || "Unknown error")
        .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
        .replace(/token[=:]\s*\S+/gi, "token=[REDACTED]");
      return { content: [{ type: "text" as const, text: `Error crawling ${url}: ${safeMsg}` }], isError: true };
    }
  },
);

// ─── Tool: crawl_site ───

server.tool(
  "crawl_site",
  "Crawl multiple pages on a website. Starts from a URL, follows internal links up to a depth limit. Returns all pages as markdown. Great for documentation sites, blogs, product pages.",
  {
    url: z.string().url().describe("Starting URL"),
    max_pages: z.number().min(1).max(20).default(5).describe("Maximum pages to crawl (1-20, default: 5)"),
    max_depth: z.number().min(1).max(3).default(2).describe("Link depth to follow (1-3, default: 2)"),
    same_domain: z.boolean().default(true).describe("Only follow links on the same domain (default: true)"),
    save_to_cortex: z.boolean().optional().describe("Save each page to Cortex Archive"),
  },
  async ({ url, max_pages, max_depth, same_domain, save_to_cortex: saveCortex }) => {
    try {
      const startDomain = new URL(url).hostname;
      const visited = new Set<string>();
      const queue: Array<{ url: string; depth: number }> = [{ url, depth: 0 }];
      const results: Array<{ url: string; title: string; markdown: string }> = [];

      while (queue.length > 0 && results.length < max_pages) {
        const item = queue.shift()!;
        if (visited.has(item.url)) continue;
        visited.add(item.url);

        try {
          const { html, title, url: finalUrl } = await fetchPage(item.url);
          let markdown = htmlToMarkdown(html);

          if (markdown.length > MAX_CONTENT_LENGTH / max_pages) {
            markdown = markdown.substring(0, MAX_CONTENT_LENGTH / max_pages) + "\n[... truncated ...]";
          }

          results.push({ url: finalUrl, title, markdown });

          if (saveCortex) {
            await saveToCortex(title, markdown, finalUrl);
          }

          // Discover child links
          if (item.depth < max_depth) {
            const links = extractLinks(html, finalUrl);
            for (const link of links) {
              if (visited.has(link)) continue;
              if (same_domain && new URL(link).hostname !== startDomain) continue;
              queue.push({ url: link, depth: item.depth + 1 });
            }
          }
        } catch {
          // Skip failed pages
        }
      }

      let output = `# Site Crawl: ${url}\n\n**Pages crawled:** ${results.length}/${max_pages}\n\n---\n\n`;
      for (const page of results) {
        output += `## ${page.title}\n**URL:** ${page.url}\n\n${page.markdown}\n\n---\n\n`;
      }

      if (output.length > MAX_CONTENT_LENGTH) {
        output = output.substring(0, MAX_CONTENT_LENGTH) + "\n\n[... output truncated ...]";
      }

      return { content: [{ type: "text" as const, text: output }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error crawling site ${url}: ${err.message}` }], isError: true };
    }
  },
);

// ─── Tool: crawl_extract ───

server.tool(
  "crawl_extract",
  "Extract structured data from a web page using CSS selectors or natural language field descriptions. Returns JSON. Perfect for scraping product listings, job postings, articles, pricing tables.",
  {
    url: z.string().url().describe("The URL to extract from"),
    fields: z.array(z.object({
      name: z.string().describe("Field name (e.g. 'title', 'price', 'author')"),
      selector: z.string().optional().describe("CSS selector to target (e.g. 'h1', '.price', 'article p:first-child')"),
      attribute: z.string().optional().describe("HTML attribute to extract (default: text content). Use 'href' for links, 'src' for images."),
      multiple: z.boolean().optional().describe("Extract all matches (default: false = first match only)"),
    })).describe("Fields to extract"),
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
        await page.setUserAgent("UBIK-Crawl/1.0");
        await page.goto(url, { waitUntil: "networkidle2", timeout: DEFAULT_TIMEOUT });

        if (wait_for) {
          await page.waitForSelector(wait_for, { timeout: 5000 }).catch(() => {});
        }

        const extracted: Record<string, any> = { _source: url };

        for (const field of fields) {
          if (!field.selector) {
            extracted[field.name] = null;
            continue;
          }

          if (field.multiple) {
            extracted[field.name] = await page.$$eval(
              field.selector,
              (els, attr) => els.map((el) => attr ? el.getAttribute(attr) || "" : el.textContent?.trim() || ""),
              field.attribute || "",
            );
          } else {
            extracted[field.name] = await page.$eval(
              field.selector,
              (el, attr) => attr ? el.getAttribute(attr) || "" : el.textContent?.trim() || "",
              field.attribute || "",
            ).catch(() => null);
          }
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(extracted, null, 2) }],
        };
      } finally {
        await browser.close();
      }
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error extracting from ${url}: ${err.message}` }], isError: true };
    }
  },
);

// ─── Tool: crawl_search ───

server.tool(
  "crawl_search",
  "Search the web for a query, then crawl and convert the top results to markdown. Combines web search with content extraction.",
  {
    query: z.string().describe("Search query"),
    max_results: z.number().min(1).max(5).default(3).describe("Number of results to crawl (1-5, default: 3)"),
    save_to_cortex: z.boolean().optional().describe("Save results to Cortex Archive"),
  },
  async ({ query, max_results, save_to_cortex: saveCortex }) => {
    try {
      // Use DuckDuckGo HTML search (no API key needed)
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const { html } = await fetchPage(searchUrl, { javascript: false });

      // Extract result URLs from DuckDuckGo
      const urlRegex = /class="result__a"[^>]*href="([^"]+)"/g;
      const urls: string[] = [];
      let match;
      while ((match = urlRegex.exec(html)) !== null && urls.length < max_results) {
        try {
          // DuckDuckGo wraps URLs in redirects
          const rawUrl = match[1];
          const decoded = decodeURIComponent(rawUrl.replace(/.*uddg=/, "").replace(/&.*/, ""));
          if (decoded.startsWith("http")) urls.push(decoded);
        } catch { /* skip */ }
      }

      // Fallback: extract any href that looks like a result
      if (urls.length === 0) {
        const fallbackRegex = /href="(https?:\/\/(?!duckduckgo)[^"]+)"/g;
        while ((match = fallbackRegex.exec(html)) !== null && urls.length < max_results) {
          urls.push(match[1]);
        }
      }

      if (urls.length === 0) {
        return { content: [{ type: "text" as const, text: `No results found for: "${query}"` }] };
      }

      let output = `# Search: "${query}"\n\n**Results found:** ${urls.length}\n\n---\n\n`;

      for (const resultUrl of urls) {
        try {
          const { html: pageHtml, title } = await fetchPage(resultUrl);
          let markdown = htmlToMarkdown(pageHtml);
          if (markdown.length > MAX_CONTENT_LENGTH / max_results) {
            markdown = markdown.substring(0, MAX_CONTENT_LENGTH / max_results) + "\n[... truncated ...]";
          }
          output += `## ${title}\n**URL:** ${resultUrl}\n\n${markdown}\n\n---\n\n`;

          if (saveCortex) {
            await saveToCortex(title, markdown, resultUrl);
          }
        } catch {
          output += `## ${resultUrl}\n*Failed to crawl this page.*\n\n---\n\n`;
        }
      }

      return { content: [{ type: "text" as const, text: output }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Search error: ${err.message}` }], isError: true };
    }
  },
);

// ─── Tool: crawl_map ───

server.tool(
  "crawl_map",
  "Discover all URLs on a website. Checks sitemap.xml first, then crawls pages to collect internal links. Returns a flat list of URLs.",
  {
    url: z.string().url().describe("Website root URL"),
    max_urls: z.number().min(1).max(200).default(50).describe("Maximum URLs to discover (1-200, default: 50)"),
  },
  async ({ url, max_urls }) => {
    try {
      const domain = new URL(url).origin;
      const allUrls = new Set<string>();

      // 1. Try sitemap.xml
      try {
        const sitemapUrl = `${domain}/sitemap.xml`;
        const { html } = await fetchPage(sitemapUrl, { javascript: false });
        const locRegex = /<loc>(.*?)<\/loc>/g;
        let match;
        while ((match = locRegex.exec(html)) !== null) {
          allUrls.add(match[1]);
        }
      } catch { /* no sitemap */ }

      // 2. Crawl the main page for links
      if (allUrls.size < max_urls) {
        try {
          const { html } = await fetchPage(url);
          const links = extractLinks(html, url);
          for (const link of links) {
            if (allUrls.size >= max_urls) break;
            if (new URL(link).hostname === new URL(url).hostname) {
              allUrls.add(link);
            }
          }
        } catch { /* skip */ }
      }

      const urlList = [...allUrls].slice(0, max_urls).sort();
      let output = `# Site Map: ${url}\n\n**URLs discovered:** ${urlList.length}\n\n`;
      output += urlList.map((u) => `- ${u}`).join("\n");

      return { content: [{ type: "text" as const, text: output }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error mapping ${url}: ${err.message}` }], isError: true };
    }
  },
);

// ─── Start server ───

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  wrapTransportWithAuth(transport, auth);

  console.error("[UBIK Crawl] MCP server running (stdio)");
}

main().catch((err) => {
  console.error("[UBIK Crawl] Fatal:", err);
  process.exit(1);
});
