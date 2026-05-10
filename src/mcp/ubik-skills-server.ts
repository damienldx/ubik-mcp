#!/usr/bin/env node
/**
 * UBIK Skills — MCP Server (stdio transport)
 *
 * Provides the missing tools referenced by the SKILLS library
 * that are not natively available in Claude Code / Gemini CLI.
 *
 * Tools:
 *   - file_outline      → Extract structure (functions, classes, exports) from a file
 *   - code_review       → Analyze code and return suggestions/issues
 *   - save_context      → Write to Cortex Archive (POST /api/context)
 *   - read_context      → Read from Cortex (GET /api/context)
 *   - list_context      → List/filter Cortex entries
 *   - export_artifact   → Export structured output to a file (text + binary formats)
 *   - init_project      → Scaffold a project from a template
 *   - generate_document → Generate XLSX, DOCX, PDF, CSV, HTML files
 *   - screenshot_url    → Capture a web page screenshot
 *   - generate_chart    → Create interactive ECharts graphs (cyberpunk theme)
 *   - read_database     → Read-only SQL queries on SQLite
 *   - analyze_db_schema → Discover database schema
 *   - analyze_data      → Statistical analysis of CSV/JSON files
 *   - scrape_extract    → Structured web scraping with Puppeteer
 *   - convert_format    → File format conversion via Pandoc
 *   - transcribe_audio  → Speech-to-text via Gemini 3.1 Flash Live
 *   - ocr_extract       → Image/PDF text extraction via Tesseract.js
 *   - send_email_pro    → Transactional email via Resend
 *   - find_free_slots   → Smart calendar slot finder
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { generateDocument } from "../lib/document-generator.js";
import { buildHtmlArtifact, buildHtmlArtifactStreaming } from "../lib/html-artifact-builder.js";
import { createCanvasSession, emitCanvasEvent } from "../lib/canvas-session.js";
import {
  screenshotUrl, generateChart, readDatabase, analyzeDatabaseSchema,
  analyzeData, scrapeAndExtract, convertFileFormat,
  transcribeAudio, ocrExtract, sendEmailPro, findFreeSlots,
} from "../lib/agent-tools.js";
import path from "node:path";
import { config } from "dotenv";
import { createMcpAuth, wrapTransportWithAuth } from "../lib/mcp-auth.js";

// Load .env from project root (cwd is set to UBIK root by .mcp.json)
config({ path: path.join(process.cwd(), ".env") });

const auth = createMcpAuth("ubik-skills");

// ─── Constants ───

const UBIK_API = process.env.UBIK_API_URL || process.env.UBIK_BASE_URL || "http://localhost:3001";

// ─── Helpers ───

function safeRead(filePath: string): string {
  try {
    return readFileSync(filePath, "utf-8");
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const safeMsg = rawMsg
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/token[=:]\s*\S+/gi, "token=[REDACTED]");
    throw new Error(`Cannot read file: ${filePath} — ${safeMsg}`);
  }
}

function detectLang(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
    ".py": "python", ".rs": "rust", ".go": "go", ".java": "java", ".c": "c", ".cpp": "cpp",
    ".h": "c", ".hpp": "cpp", ".cs": "csharp", ".rb": "ruby", ".php": "php",
    ".swift": "swift", ".kt": "kotlin", ".scala": "scala", ".vue": "vue",
    ".svelte": "svelte", ".css": "css", ".scss": "scss", ".html": "html",
    ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
    ".sql": "sql", ".sh": "shell", ".bash": "shell", ".zsh": "shell",
    ".md": "markdown", ".mdx": "markdown",
  };
  return map[ext] || "unknown";
}

// ─── file_outline: AST-lite structure extraction ───

interface OutlineEntry {
  type: "import" | "export" | "function" | "class" | "interface" | "type" | "enum" | "const" | "variable" | "method" | "hook" | "component" | "route" | "other";
  name: string;
  line: number;
  signature?: string;
}

function extractOutline(content: string, lang: string): OutlineEntry[] {
  const lines = content.split("\n");
  const entries: OutlineEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNum = i + 1;

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

    // Imports
    if (/^import\s/.test(trimmed)) {
      const match = trimmed.match(/^import\s+(?:(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))*\s+from\s+)?['"](.*?)['"]/);
      entries.push({ type: "import", name: match ? match[1] : trimmed.slice(0, 80), line: lineNum });
      continue;
    }

    // Python imports
    if (lang === "python" && /^(?:from\s+\S+\s+)?import\s/.test(trimmed)) {
      entries.push({ type: "import", name: trimmed.slice(0, 80), line: lineNum });
      continue;
    }

    // Exports (named, default)
    if (/^export\s+default\s/.test(trimmed)) {
      const match = trimmed.match(/^export\s+default\s+(?:function|class|const)?\s*(\w+)?/);
      entries.push({ type: "export", name: match?.[1] || "default", line: lineNum, signature: trimmed.slice(0, 100) });
      continue;
    }

    // Exported declarations (will be caught below too, but mark as export)
    const isExported = trimmed.startsWith("export ");
    const effective = isExported ? trimmed.replace(/^export\s+/, "") : trimmed;

    // Classes
    const classMatch = effective.match(/^(?:abstract\s+)?class\s+(\w+)/);
    if (classMatch) {
      entries.push({ type: "class", name: classMatch[1], line: lineNum, signature: trimmed.slice(0, 120) });
      continue;
    }

    // Interfaces (TS)
    const ifaceMatch = effective.match(/^interface\s+(\w+)/);
    if (ifaceMatch) {
      entries.push({ type: "interface", name: ifaceMatch[1], line: lineNum, signature: trimmed.slice(0, 120) });
      continue;
    }

    // Type aliases (TS)
    const typeMatch = effective.match(/^type\s+(\w+)\s*[<=]/);
    if (typeMatch) {
      entries.push({ type: "type", name: typeMatch[1], line: lineNum, signature: trimmed.slice(0, 120) });
      continue;
    }

    // Enums
    const enumMatch = effective.match(/^enum\s+(\w+)/);
    if (enumMatch) {
      entries.push({ type: "enum", name: enumMatch[1], line: lineNum });
      continue;
    }

    // Functions (named, async, generator)
    const funcMatch = effective.match(/^(?:async\s+)?function\s*\*?\s+(\w+)/);
    if (funcMatch) {
      const name = funcMatch[1];
      // React component detection (PascalCase)
      const isComponent = /^[A-Z]/.test(name) && ["typescript", "javascript"].includes(lang);
      // Hook detection
      const isHook = name.startsWith("use") && /^use[A-Z]/.test(name);
      entries.push({
        type: isHook ? "hook" : isComponent ? "component" : "function",
        name, line: lineNum, signature: trimmed.slice(0, 120),
      });
      continue;
    }

    // Arrow functions / const declarations
    const constMatch = effective.match(/^(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=/);
    if (constMatch) {
      const name = constMatch[1];
      const isArrowFn = /=>\s*[\{(]/.test(trimmed) || /=\s*(?:async\s+)?\(/.test(trimmed);
      const isComponent = /^[A-Z]/.test(name) && isArrowFn;
      const isHook = name.startsWith("use") && /^use[A-Z]/.test(name);
      entries.push({
        type: isHook ? "hook" : isComponent ? "component" : isArrowFn ? "function" : "const",
        name, line: lineNum, signature: trimmed.slice(0, 120),
      });
      continue;
    }

    // Python: def / class
    if (lang === "python") {
      const pyFunc = trimmed.match(/^(?:async\s+)?def\s+(\w+)/);
      if (pyFunc) {
        entries.push({ type: "function", name: pyFunc[1], line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }
      const pyClass = trimmed.match(/^class\s+(\w+)/);
      if (pyClass) {
        entries.push({ type: "class", name: pyClass[1], line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }
    }

    // Go: func
    if (lang === "go") {
      const goFunc = trimmed.match(/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/);
      if (goFunc) {
        entries.push({ type: "function", name: goFunc[1], line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }
    }

    // Rust: fn, struct, impl, trait, enum
    if (lang === "rust") {
      const rsFn = trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/);
      if (rsFn) { entries.push({ type: "function", name: rsFn[1], line: lineNum, signature: trimmed.slice(0, 120) }); continue; }
      const rsStruct = trimmed.match(/^(?:pub\s+)?struct\s+(\w+)/);
      if (rsStruct) { entries.push({ type: "class", name: rsStruct[1], line: lineNum }); continue; }
      const rsTrait = trimmed.match(/^(?:pub\s+)?trait\s+(\w+)/);
      if (rsTrait) { entries.push({ type: "interface", name: rsTrait[1], line: lineNum }); continue; }
    }

    // Next.js route handlers
    if (/^export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/.test(trimmed)) {
      const routeMatch = trimmed.match(/function\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)/);
      if (routeMatch) {
        entries.push({ type: "route", name: routeMatch[1], line: lineNum, signature: trimmed.slice(0, 120) });
      }
    }
  }

  return entries;
}

// ─── code_review: Static analysis patterns ───

interface ReviewIssue {
  severity: "error" | "warning" | "info";
  line: number;
  message: string;
  rule: string;
}

function reviewCode(content: string, lang: string): { issues: ReviewIssue[]; score: number; summary: string } {
  const lines = content.split("\n");
  const issues: ReviewIssue[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNum = i + 1;

    // console.log left in code
    if (/\bconsole\.(log|debug|info)\b/.test(trimmed) && !trimmed.startsWith("//")) {
      issues.push({ severity: "warning", line: lineNum, message: "console.log left in code", rule: "no-console" });
    }

    // TODO/FIXME/HACK
    if (/\b(TODO|FIXME|HACK|XXX)\b/.test(trimmed)) {
      const tag = trimmed.match(/\b(TODO|FIXME|HACK|XXX)\b/)?.[1] || "TODO";
      issues.push({ severity: "info", line: lineNum, message: `${tag} comment found`, rule: "no-todo" });
    }

    // any type usage (TS)
    if (["typescript", "javascript"].includes(lang) && /:\s*any\b/.test(trimmed)) {
      issues.push({ severity: "warning", line: lineNum, message: "Explicit 'any' type — consider stricter typing", rule: "no-explicit-any" });
    }

    // Hardcoded secrets patterns
    if (/(?:password|secret|api_key|apikey|token)\s*[:=]\s*['"][^'"]{4,}/i.test(trimmed) && !trimmed.startsWith("//")) {
      issues.push({ severity: "error", line: lineNum, message: "Possible hardcoded secret/credential", rule: "no-hardcoded-secrets" });
    }

    // Empty catch blocks
    if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(trimmed)) {
      issues.push({ severity: "warning", line: lineNum, message: "Empty catch block — errors are silently swallowed", rule: "no-empty-catch" });
    }

    // Very long lines
    if (line.length > 200) {
      issues.push({ severity: "info", line: lineNum, message: `Line too long (${line.length} chars)`, rule: "max-line-length" });
    }

    // eval usage
    if (/\beval\s*\(/.test(trimmed)) {
      issues.push({ severity: "error", line: lineNum, message: "eval() usage — potential security risk", rule: "no-eval" });
    }

    // SQL injection patterns
    if (/\$\{.*\}.*(?:SELECT|INSERT|UPDATE|DELETE|DROP)\b/i.test(trimmed) || /(?:SELECT|INSERT|UPDATE|DELETE|DROP).*\+\s*\w+/i.test(trimmed)) {
      issues.push({ severity: "error", line: lineNum, message: "Possible SQL injection — use parameterized queries", rule: "no-sql-injection" });
    }

    // Nested ternaries
    if ((trimmed.match(/\?/g) || []).length >= 2 && (trimmed.match(/:/g) || []).length >= 2) {
      issues.push({ severity: "warning", line: lineNum, message: "Nested ternary — consider if/else for readability", rule: "no-nested-ternary" });
    }

    // Magic numbers (outside common values)
    if (["typescript", "javascript"].includes(lang)) {
      const magicMatch = trimmed.match(/(?<![.\w])(\d{3,})(?!\w)/);
      if (magicMatch && !trimmed.includes("port") && !trimmed.startsWith("//") && !trimmed.startsWith("import")
          && !["1000", "1024", "3000", "3001", "8080", "8443", "443", "100", "200", "404", "500"].includes(magicMatch[1])) {
        issues.push({ severity: "info", line: lineNum, message: `Magic number ${magicMatch[1]} — consider named constant`, rule: "no-magic-numbers" });
      }
    }
  }

  // Scoring
  const errorCount = issues.filter(i => i.severity === "error").length;
  const warningCount = issues.filter(i => i.severity === "warning").length;
  const infoCount = issues.filter(i => i.severity === "info").length;
  const score = Math.max(0, Math.min(100, 100 - (errorCount * 15) - (warningCount * 5) - (infoCount * 1)));

  const summary = `${errorCount} errors, ${warningCount} warnings, ${infoCount} info — Score: ${score}/100`;

  return { issues, score, summary };
}

// ─── MCP Server ───

const server = new McpServer({
  name: "ubik-skills",
  version: "1.0.0",
});

// ── Tool: file_outline ──

server.tool(
  "file_outline",
  "Extract the structural outline of a source file: functions, classes, interfaces, types, exports, imports, hooks, components, route handlers. Supports TS/JS, Python, Go, Rust.",
  {
    path: z.string().describe("Absolute path to the file to analyze"),
  },
  async ({ path: filePath }) => {
    const content = safeRead(filePath);
    const lang = detectLang(filePath);
    const outline = extractOutline(content, lang);
    const totalLines = content.split("\n").length;

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          file: filePath,
          language: lang,
          totalLines,
          entries: outline,
          summary: {
            imports: outline.filter(e => e.type === "import").length,
            exports: outline.filter(e => e.type === "export").length,
            functions: outline.filter(e => e.type === "function").length,
            classes: outline.filter(e => e.type === "class").length,
            interfaces: outline.filter(e => e.type === "interface").length,
            types: outline.filter(e => e.type === "type").length,
            components: outline.filter(e => e.type === "component").length,
            hooks: outline.filter(e => e.type === "hook").length,
            routes: outline.filter(e => e.type === "route").length,
            constants: outline.filter(e => e.type === "const").length,
          },
        }, null, 2),
      }],
    };
  }
);

// ── Tool: code_review ──

server.tool(
  "code_review",
  "Static analysis of a source file: detect security issues, code smells, TODOs, hardcoded secrets, eval usage, SQL injection patterns, and more. Returns issues with severity + score.",
  {
    path: z.string().describe("Absolute path to the file to review"),
  },
  async ({ path: filePath }) => {
    const content = safeRead(filePath);
    const lang = detectLang(filePath);
    const result = reviewCode(content, lang);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          file: filePath,
          language: lang,
          ...result,
        }, null, 2),
      }],
    };
  }
);

// ── Tool: save_context ──

server.tool(
  "save_context",
  "Save a memory/context entry to the Cortex Archive (shared between Claude & Gemini). Types: decision, convention, bug_fix, architecture, observation.",
  {
    type: z.enum(["decision", "convention", "bug_fix", "architecture", "observation"]).describe("Type of context entry"),
    title: z.string().describe("Short title for the entry"),
    content: z.string().describe("The content to save"),
    tags: z.array(z.string()).optional().describe("Tags for filtering"),
  },
  async ({ type, title, content, tags }) => {
    const caller = process.env.UBIK_MCP_CALLER || "unknown";
    try {
      const res = await fetch(`${UBIK_API}/api/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth.getAuthHeaders() },
        body: JSON.stringify({
          layer: "archive", action: "create",
          type, source: caller, title, content,
          tags: tags || [],
        }),
      });
      const data = await res.json();
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, ...data }, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Failed to save context: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── Tool: read_context ──

server.tool(
  "read_context",
  "Read context/memory from Cortex. Layers: global (prefs), projects (active projects), tasks (active tasks), archive (long-term memory).",
  {
    layer: z.enum(["global", "projects", "tasks", "archive"]).describe("Which Cortex layer to read"),
    limit: z.number().optional().describe("Max entries to return (default 10)"),
  },
  async ({ layer, limit }) => {
    try {
      const url = `${UBIK_API}/api/context?layer=${layer}&limit=${limit || 10}`;
      const caller = process.env.UBIK_MCP_CALLER || "unknown";
      const res = await fetch(url, { headers: auth.getAuthHeaders() });
      const data = await res.json();
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Failed to read context: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── Tool: list_context ──

server.tool(
  "list_context",
  "List and filter Cortex Archive entries by type, source, or tags.",
  {
    type: z.string().optional().describe("Filter by type: decision, convention, bug_fix, architecture, observation"),
    source: z.string().optional().describe("Filter by source: claude, gemini"),
    tag: z.string().optional().describe("Filter by tag"),
    limit: z.number().optional().describe("Max entries (default 20)"),
  },
  async ({ type, source, tag, limit }) => {
    try {
      const params = new URLSearchParams({ layer: "archive", limit: String(limit || 20) });
      if (type) params.set("type", type);
      if (source) params.set("source", source);
      if (tag) params.set("tag", tag);

      const caller = process.env.UBIK_MCP_CALLER || "unknown";
      const res = await fetch(`${UBIK_API}/api/context?${params}`, { headers: auth.getAuthHeaders() });
      const data = await res.json();
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Failed to list context: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── Tool: export_artifact ──

server.tool(
  "export_artifact",
  "Export structured content to a file. Text formats: json, markdown, csv, text. Binary formats: xlsx, docx, pdf, html (delegates to generate_document).",
  {
    outputPath: z.string().describe("Absolute path for the output file"),
    format: z.enum(["json", "markdown", "csv", "text", "xlsx", "docx", "pdf", "html"]).describe("Output format"),
    title: z.string().describe("Title/header for the artifact"),
    content: z.string().describe("The content to export (raw string, or JSON string for json/csv/xlsx/docx/pdf)"),
  },
  async ({ outputPath, format, title, content: rawContent }) => {
    try {
      // Binary formats → delegate to generateDocument
      if (["xlsx", "docx", "pdf", "html"].includes(format)) {
        const result = await generateDocument(format, outputPath, rawContent);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          isError: !result.success,
        };
      }

      const dir = path.dirname(outputPath);
      mkdirSync(dir, { recursive: true });

      let output: string;

      switch (format) {
        case "json": {
          try {
            const parsed = JSON.parse(rawContent);
            output = JSON.stringify({ title, exportedAt: new Date().toISOString(), data: parsed }, null, 2);
          } catch {
            output = JSON.stringify({ title, exportedAt: new Date().toISOString(), data: rawContent }, null, 2);
          }
          break;
        }
        case "markdown": {
          output = `# ${title}\n\n_Exported: ${new Date().toISOString()}_\n\n${rawContent}\n`;
          break;
        }
        case "csv": {
          output = rawContent;
          break;
        }
        default: {
          output = `${title}\n${"=".repeat(title.length)}\n\n${rawContent}\n`;
        }
      }

      writeFileSync(outputPath, output, "utf-8");

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            path: outputPath,
            format,
            size: Buffer.byteLength(output),
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Failed to export: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── Tool: init_project ──

server.tool(
  "init_project",
  "Scaffold a new project directory with standard structure. Templates: nextjs, api, library, script.",
  {
    name: z.string().describe("Project name (kebab-case)"),
    template: z.enum(["nextjs", "api", "library", "script"]).describe("Project template"),
    outputDir: z.string().optional().describe("Parent directory (defaults to ~/ubik-workspace/)"),
  },
  async ({ name, template, outputDir }) => {
    const parentDir = outputDir || path.join(process.env.HOME || "/home/user", "ubik-workspace");
    const projectDir = path.join(parentDir, name);

    if (existsSync(projectDir)) {
      return {
        content: [{ type: "text" as const, text: `Directory already exists: ${projectDir}` }],
        isError: true,
      };
    }

    const templates: Record<string, string[]> = {
      nextjs: [
        "src/app/page.tsx",
        "src/app/layout.tsx",
        "src/app/globals.css",
        "src/components/.gitkeep",
        "src/lib/.gitkeep",
        "public/.gitkeep",
        "package.json",
        "tsconfig.json",
        "next.config.ts",
        "tailwind.config.ts",
        ".gitignore",
      ],
      api: [
        "src/index.ts",
        "src/routes/.gitkeep",
        "src/middleware/.gitkeep",
        "src/lib/.gitkeep",
        "tests/.gitkeep",
        "package.json",
        "tsconfig.json",
        ".gitignore",
      ],
      library: [
        "src/index.ts",
        "src/lib/.gitkeep",
        "tests/.gitkeep",
        "package.json",
        "tsconfig.json",
        ".gitignore",
      ],
      script: [
        "src/main.ts",
        "package.json",
        "tsconfig.json",
        ".gitignore",
      ],
    };

    const files = templates[template] || templates.script;
    const created: string[] = [];

    for (const file of files) {
      const fullPath = path.join(projectDir, file);
      mkdirSync(path.dirname(fullPath), { recursive: true });

      if (file.endsWith(".gitkeep")) {
        writeFileSync(fullPath, "", "utf-8");
      } else if (file === "package.json") {
        writeFileSync(fullPath, JSON.stringify({
          name,
          version: "0.1.0",
          private: true,
          type: "module",
          scripts: { dev: "tsx watch src/index.ts", build: "tsc", start: "node dist/index.js" },
        }, null, 2), "utf-8");
      } else if (file === ".gitignore") {
        writeFileSync(fullPath, "node_modules/\ndist/\n.env\n*.log\n", "utf-8");
      } else if (file === "tsconfig.json") {
        writeFileSync(fullPath, JSON.stringify({
          compilerOptions: {
            target: "ES2022", module: "ESNext", moduleResolution: "bundler",
            strict: true, esModuleInterop: true, outDir: "dist", rootDir: "src",
          },
          include: ["src"],
        }, null, 2), "utf-8");
      } else {
        writeFileSync(fullPath, `// ${file}\n`, "utf-8");
      }
      created.push(file);
    }

    // Init git
    try {
      execFileSync("git", ["init"], { cwd: projectDir, encoding: "utf-8", timeout: 10_000 });
      execFileSync("git", ["add", "-A"], { cwd: projectDir, encoding: "utf-8", timeout: 10_000 });
      execFileSync("git", ["commit", "-m", "init: scaffold project"], { cwd: projectDir, encoding: "utf-8", timeout: 10_000 });
    } catch {
      // git init is best-effort
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: true,
          projectDir,
          template,
          files: created,
          count: created.length,
        }, null, 2),
      }],
    };
  }
);

// ── Tool: generate_document ──

server.tool(
  "generate_document",
  "Generate a binary/office document file. Formats: xlsx (Excel), docx (Word), pdf, csv, html. Provide structured JSON data. Creates the file directly on disk.",
  {
    format: z.enum(["xlsx", "csv", "docx", "pdf", "html"]).describe("Output format"),
    outputPath: z.string().describe("Absolute path for the output file (e.g. /home/user/rapport.xlsx)"),
    data: z.string().describe("JSON string with structured data. xlsx: {sheets:[{name,headers,rows}]}. docx: {sections:[{heading?,paragraph?,list?,table?}]}. pdf: {title?,sections:[{heading?,text?,list?,table?}]}. csv: {headers,rows}. html: {title?,body}"),
  },
  async ({ format, outputPath, data }) => {
    const result = await generateDocument(format, outputPath, data);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      isError: !result.success,
    };
  }
);

// ── Tool: screenshot_url ──

server.tool(
  "screenshot_url",
  "Capture a screenshot of a web page using Puppeteer. Returns a PNG image file.",
  {
    url: z.string().describe("URL to capture"),
    outputPath: z.string().describe("Absolute path for the PNG output"),
    width: z.number().optional().describe("Viewport width (default 1280)"),
    height: z.number().optional().describe("Viewport height (default 720)"),
    fullPage: z.boolean().optional().describe("Capture full page (default false)"),
  },
  async ({ url, outputPath, width, height, fullPage }) => {
    const result = await screenshotUrl(url, outputPath, { width, height, fullPage });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      isError: !result.success,
    };
  }
);

// ── Tool: generate_chart ──

server.tool(
  "generate_chart",
  "Generate an interactive chart as an HTML file using Apache ECharts with cyberpunk dark theme. Types: bar, barH (horizontal), line, pie, doughnut, radar, polarArea, heatmap, treemap, sankey.",
  {
    chartType: z.string().describe("Chart type: bar, barH, line, pie, doughnut, radar, polarArea, heatmap, treemap, sankey"),
    data: z.string().describe('JSON: {labels:["A","B"],datasets:[{label:"...",data:[1,2]}]} or {labels:[...],values:[...]}. Heatmap: {labels,yLabels,data:[[x,y,val]]}. Sankey: {nodes:[{name}],links:[{source,target,value}]}. Treemap: {data:[{name,value,children?}]}'),
    outputPath: z.string().describe("Absolute path for the HTML output"),
    title: z.string().optional().describe("Chart title"),
  },
  async ({ chartType, data, outputPath, title }) => {
    const result = await generateChart(chartType, data, outputPath, { title });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      isError: !result.success,
    };
  }
);

// ── Tool: read_database ──

server.tool(
  "read_database",
  "Execute a read-only SQL query on a SQLite database. Only SELECT, PRAGMA, EXPLAIN are allowed. Returns formatted table.",
  {
    query: z.string().describe("SQL query (SELECT only)"),
    dbPath: z.string().optional().describe("Path to SQLite DB (default: project db)"),
    limit: z.number().optional().describe("Max rows (default 100)"),
  },
  async ({ query, dbPath, limit }) => {
    const result = await readDatabase(query, { dbPath, limit });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      isError: !result.success,
    };
  }
);

// ── Tool: analyze_db_schema ──

server.tool(
  "analyze_db_schema",
  "Discover the schema of a SQLite database: list tables, columns, types, row counts. Optionally inspect a specific table with sample data.",
  {
    dbPath: z.string().optional().describe("Path to SQLite DB (default: project db)"),
    table: z.string().optional().describe("Specific table to inspect in detail"),
  },
  async ({ dbPath, table }) => {
    const result = await analyzeDatabaseSchema({ dbPath, table });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      isError: !result.success,
    };
  }
);

// ── Tool: analyze_data ──

server.tool(
  "analyze_data",
  "Statistical analysis of a CSV, TSV, or JSON data file. Returns dimensions, column types, stats (mean, median, std), top values for categorical columns.",
  {
    filePath: z.string().describe("Absolute path to the data file (.csv, .tsv, .json)"),
  },
  async ({ filePath }) => {
    const result = await analyzeData(filePath);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      isError: !result.success,
    };
  }
);

// ── Tool: scrape_extract ──

server.tool(
  "scrape_extract",
  "Scrape a web page and extract structured data using CSS selectors. Uses Puppeteer for JS-rendered pages.",
  {
    url: z.string().describe("URL to scrape"),
    fields: z.string().describe('JSON array: [{"name":"title","selector":"h1"},{"name":"link","selector":"a","attribute":"href"}]'),
    selector: z.string().optional().describe("Container CSS selector (default: body)"),
    multiple: z.boolean().optional().describe("Extract from multiple matching containers (default: true)"),
  },
  async ({ url, fields, selector, multiple }) => {
    const result = await scrapeAndExtract(url, fields, { selector, multiple });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      isError: !result.success,
    };
  }
);

// ── Tool: convert_format ──

server.tool(
  "convert_format",
  "Convert a file between formats using Pandoc (md, html, docx, pdf, rst, epub, odt, rtf, etc.).",
  {
    inputPath: z.string().describe("Absolute path to input file"),
    outputPath: z.string().describe("Absolute path for converted output"),
    from: z.string().optional().describe("Source format (auto-detected from extension)"),
    to: z.string().optional().describe("Target format (auto-detected from extension)"),
  },
  async ({ inputPath, outputPath, from, to }) => {
    const result = await convertFileFormat(inputPath, outputPath, { from, to });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      isError: !result.success,
    };
  }
);

// ── Tool: transcribe_audio ──

server.tool(
  "transcribe_audio",
  "Transcribe an audio file to text using Gemini 3.1 Flash Live. Supports mp3, mp4, m4a, wav, webm, ogg, flac. Returns full transcription with noise-robust 90+ language support.",
  {
    inputPath: z.string().describe("Absolute path to the audio file"),
    language: z.string().optional().describe("Language hint (ISO 639-1: fr, en, es, de...)"),
    format: z.string().optional().describe("Output format: text (default), srt, vtt, json"),
  },
  async ({ inputPath, language, format }) => {
    const result = await transcribeAudio(inputPath, { language, format });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      isError: !result.success,
    };
  }
);

// ── Tool: ocr_extract ──

server.tool(
  "ocr_extract",
  "Extract text from an image using OCR (Tesseract.js). Supports PNG, JPG, TIFF, BMP, PDF (first page). Returns extracted text with confidence score.",
  {
    inputPath: z.string().describe("Absolute path to the image file"),
    language: z.string().optional().describe("OCR language (default: fra+eng). Use ISO 639-3: fra, eng, deu, spa..."),
  },
  async ({ inputPath, language }) => {
    const result = await ocrExtract(inputPath, { language });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      isError: !result.success,
    };
  }
);

// ── Tool: send_email_pro ──

server.tool(
  "send_email_pro",
  "Send a professional transactional email via Resend (newsletters, invoices, notifications). Supports HTML and plain text. Requires RESEND_API_KEY in env.",
  {
    to: z.union([z.string(), z.array(z.string())]).describe("Recipient email(s)"),
    subject: z.string().describe("Email subject"),
    html: z.string().optional().describe("HTML body content"),
    text: z.string().optional().describe("Plain text body (fallback)"),
    from: z.string().optional().describe("Sender (default: configured in RESEND_FROM)"),
    replyTo: z.string().optional().describe("Reply-to address"),
  },
  async ({ to, subject, html, text, from, replyTo }) => {
    const result = await sendEmailPro({ to, subject, html, text, from, replyTo });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      isError: !result.success,
    };
  }
);

// ── Tool: find_free_slots ──

server.tool(
  "find_free_slots",
  "Analyze a list of calendar events and find available time slots. Smart scheduling: respects working hours (default 9h-18h), skips weekends, configurable minimum duration.",
  {
    events: z.string().describe('JSON array of events: [{start:"ISO",end:"ISO",title?:"..."}]'),
    dateStart: z.string().optional().describe("Range start (ISO date, default: today)"),
    dateEnd: z.string().optional().describe("Range end (ISO date, default: +7 days)"),
    minDuration: z.number().optional().describe("Minimum slot duration in minutes (default: 30)"),
    workStart: z.number().optional().describe("Working day start hour (default: 9)"),
    workEnd: z.number().optional().describe("Working day end hour (default: 18)"),
  },
  async ({ events: eventsJson, dateStart, dateEnd, minDuration, workStart, workEnd }) => {
    let events;
    try { events = JSON.parse(eventsJson); } catch { return { content: [{ type: "text" as const, text: '{"success":false,"error":"events must be valid JSON"}' }], isError: true }; }
    const result = await findFreeSlots(events, {
      dateRange: dateStart || dateEnd ? { start: dateStart || new Date().toISOString(), end: dateEnd || "" } : undefined,
      minDuration,
      workingHours: workStart || workEnd ? { start: workStart || 9, end: workEnd || 18 } : undefined,
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      isError: !result.success,
    };
  }
);

// ── Tool: search_expert_docs ──

server.tool(
  "search_expert_docs",
  "Semantic search on documents attached to an active expert pattern. Uses pgvector embeddings to find the most relevant chunks. Call this when the user asks about information in the expert's reference documents.",
  {
    patternId: z.string().describe("The expert pattern ID to search in"),
    query: z.string().describe("The search query (natural language)"),
    limit: z.number().optional().describe("Max results (default: 5)"),
  },
  async ({ patternId, query, limit }) => {
    try {
      const res = await fetch(`${UBIK_API}/api/experts/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patternId, query, limit: limit || 5 }),
      });
      const data = await res.json();
      if (!data.success) {
        return { content: [{ type: "text" as const, text: `Error: ${data.error}` }], isError: true };
      }
      const text = data.results
        .map((r: { docName: string; chunkText: string; similarity: number }, i: number) =>
          `[${i + 1}] (${(r.similarity * 100).toFixed(1)}%) ${r.docName}\n${r.chunkText}`)
        .join("\n\n---\n\n");
      return { content: [{ type: "text" as const, text: text || "No matching documents found." }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
    }
  }
);

// ── Tool: list_pipeline_templates ──

server.tool(
  "list_pipeline_templates",
  "List all available skill pipeline templates. Pipelines chain multiple skills into automated workflows (e.g. Design→Plan→Implement, Research→Analyze→Report).",
  {},
  async () => {
    try {
      const { listPipelineTemplates } = await import("../lib/skill-pipeline.js");
      const templates = listPipelineTemplates();
      const output = templates.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        category: t.category,
        steps: t.steps.map((s) => s.name),
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: prepare_pipeline ──

server.tool(
  "prepare_pipeline",
  "Prepare a skill pipeline for execution. Returns the steps with their prompts ready for sequential execution. Use a template ID or provide custom skill IDs.",
  {
    template_id: z.string().optional().describe("Pipeline template ID (e.g. 'design-plan-implement')"),
    skill_ids: z.array(z.string()).optional().describe("Custom skill IDs to chain (if no template)"),
    input: z.string().describe("Initial input for the first step"),
    model: z.string().optional().describe("Default model override for all steps"),
  },
  async ({ template_id, skill_ids, input, model }) => {
    try {
      const { createPipelineFromTemplate, createPipelineFromSkills, preparePipeline } = await import("../lib/skill-pipeline.js");

      let config;
      if (template_id) {
        config = createPipelineFromTemplate(template_id, input, "agent");
        if (!config) return { content: [{ type: "text" as const, text: `Template not found: ${template_id}` }], isError: true };
      } else if (skill_ids && skill_ids.length > 0) {
        config = createPipelineFromSkills(skill_ids, input, "agent", { model });
      } else {
        return { content: [{ type: "text" as const, text: "Provide either template_id or skill_ids" }], isError: true };
      }

      if (model) config.model = model;
      const prepared = preparePipeline(config);

      const output = {
        pipelineId: config.id,
        name: config.name,
        totalSteps: prepared.length,
        steps: prepared.map((p) => ({
          id: p.step.id,
          name: p.step.name,
          skillId: p.step.skillId,
          model: p.model,
          temperature: p.temperature,
          prompt: p.userPrompt.substring(0, 500) + (p.userPrompt.length > 500 ? "..." : ""),
          hasSystemPrompt: p.systemPrompt.length > 0,
        })),
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: memory_stats ──

server.tool(
  "memory_stats",
  "Get AI memory statistics: observation count, lesson count, top patterns, success rates. Shows how UBIK learns from interactions.",
  {},
  async () => {
    try {
      const { getObservationStats } = await import("../lib/observational-memory.js");
      const { getLearningStats } = await import("../lib/learning-memory.js");

      const obsStats = await getObservationStats(auth.getUserId());
      const learnStats = await getLearningStats(auth.getUserId());

      const output = {
        observations: {
          total: obsStats.total,
          avgSuccessRate: Math.round(obsStats.avgSuccessRate * 100) + "%",
          topToolCombinations: obsStats.topTools.slice(0, 3),
          memoryAgeDays: obsStats.oldestDays,
        },
        lessons: {
          total: learnStats.total,
          successes: learnStats.successes,
          failures: learnStats.failures,
          avgWeight: Math.round(learnStats.avgWeight * 10) / 10,
          topLessons: learnStats.topLessons.slice(0, 3).map((l: any) => ({
            lesson: l.lesson.substring(0, 150),
            outcome: l.outcome,
            weight: l.weight,
          })),
        },
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: memory_consolidate ──

server.tool(
  "memory_consolidate",
  "Trigger manual consolidation of AI memory: merge similar observations, consolidate lessons, apply decay to old memories.",
  {},
  async () => {
    try {
      const { compressObservations } = await import("../lib/observational-memory.js");
      const { consolidate, decay } = await import("../lib/learning-memory.js");

      const obsResult = await compressObservations(auth.getUserId());
      const learnConsolidate = await consolidate(auth.getUserId());
      const learnDecay = await decay(auth.getUserId());

      const output = {
        observations: { merged: obsResult.merged, deleted: obsResult.deleted },
        lessons: {
          merged: learnConsolidate.merged,
          deleted: learnConsolidate.deleted,
          decayed: learnDecay.decayed,
          purged: learnDecay.purged,
        },
      };

      return { content: [{ type: "text" as const, text: `Memory consolidation complete:\n${JSON.stringify(output, null, 2)}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: generate_voice_message (Gemini TTS → WhatsApp) ──

server.tool(
  "generate_voice_message",
  "Generate a voice message using Gemini TTS and send it via WhatsApp. Supports 8 Gemini voices: kore, puck, zephyr, charon, fenrir, aoede, leda, orus. Use this for all @voice-xxx commands.",
  {
    recipient: z.string().describe("WhatsApp JID of the recipient (e.g. 33612345678@s.whatsapp.net)"),
    text: z.string().describe("Text to synthesize and send as voice message"),
    voice: z.string().optional().describe("Gemini voice: kore, puck, zephyr, charon, fenrir, aoede, leda, orus (default: kore)"),
    speed: z.number().optional().describe("Speech speed (default: 0.90)"),
  },
  async ({ recipient, text, voice, speed }) => {
    const voiceId = voice || "kore";
    try {
      const baseUrl = process.env.UBIK_BASE_URL || "http://localhost:3001";

      // 1. Generate audio via Gemini TTS
      const ttsRes = await fetch(`${baseUrl}/api/tts/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...auth.getAuthHeaders(),
        },
        body: JSON.stringify({ text, voice: voiceId, speed: speed || 0.90 }),
      });

      if (!ttsRes.ok) {
        const errText = await ttsRes.text();
        return { content: [{ type: "text" as const, text: `TTS generation failed: ${ttsRes.status} ${errText}` }], isError: true };
      }

      const ttsData = await ttsRes.json();
      if (!ttsData.success || !ttsData.audioBase64) {
        return { content: [{ type: "text" as const, text: `TTS failed: ${ttsData.error || "no audio"}` }], isError: true };
      }

      // 2. Save audio to temp file and convert to OGG Opus (WhatsApp format)
      const os = await import("os");
      const fs = await import("fs");
      const path = await import("path");
      const { execFileSync } = await import("child_process");
      const ts = Date.now();
      const rawFile = path.join(os.tmpdir(), `ubik-voice-${ts}.raw`);
      const oggFile = path.join(os.tmpdir(), `ubik-voice-${ts}.ogg`);
      fs.writeFileSync(rawFile, Buffer.from(ttsData.audioBase64, "base64"));

      // Convert PCM L16 → OGG Opus via ffmpeg
      const mime = ttsData.mimeType || "audio/L16;rate=24000";
      const rateMatch = mime.match(/rate=(\d+)/);
      const sampleRate = rateMatch ? rateMatch[1] : "24000";

      try {
        if (mime.includes("L16") || mime.includes("pcm") || mime.includes("linear")) {
          // Raw PCM: specify format explicitly
          execFileSync("ffmpeg", [
            "-y", "-f", "s16le", "-ar", sampleRate, "-ac", "1", "-i", rawFile,
            "-c:a", "libopus", "-b:a", "32k", oggFile,
          ], { timeout: 10_000 });
        } else {
          // WAV/MP3: ffmpeg auto-detects
          execFileSync("ffmpeg", [
            "-y", "-i", rawFile,
            "-c:a", "libopus", "-b:a", "32k", oggFile,
          ], { timeout: 10_000 });
        }
      } catch (ffErr: any) {
        try { fs.unlinkSync(rawFile); } catch {}
        return { content: [{ type: "text" as const, text: `Audio conversion failed: ${ffErr.message}` }], isError: true };
      }
      try { fs.unlinkSync(rawFile); } catch {}

      // 3. Send OGG Opus via WhatsApp
      const waRes = await fetch(`${baseUrl}/api/tools/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...auth.getAuthHeaders(),
        },
        body: JSON.stringify({
          tool: "send_audio_message",
          input: { recipient, media_path: oggFile, _ubikUserId: auth.getUserId() },
        }),
      });

      const waData = await waRes.json().catch(() => ({}));
      try { fs.unlinkSync(oggFile); } catch {}

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            message: `Voice message sent to ${recipient} using Gemini voice "${voiceId}"`,
            audioSize: ttsData.audioBase64.length,
            mimeType: ttsData.mimeType,
            whatsappResult: waData,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: cloned_voice_message ──

server.tool(
  "cloned_voice_message",
  "Generate a voice message using a cloned voice profile (Fine-tuning). Generates audio via Chatterbox TTS on GPU, then sends it via WhatsApp. Use this instead of generate_voice_message for cloned voices (@voice-modele-xxx).",
  {
    recipient: z.string().describe("WhatsApp JID of the recipient (e.g. 33612345678@s.whatsapp.net)"),
    text: z.string().describe("Text to synthesize with the cloned voice"),
    voiceSlug: z.string().describe("Voice profile slug (e.g. 'damien' for @voice-modele-damien)"),
    speed: z.number().optional().describe("Speech speed (default: 0.95)"),
  },
  async ({ recipient, text, voiceSlug, speed }) => {
    try {
      const baseUrl = process.env.UBIK_BASE_URL || "http://localhost:3001";

      // 1. Generate audio via TTS router
      const ttsRes = await fetch(`${baseUrl}/api/tts/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...auth.getAuthHeaders(),
        },
        body: JSON.stringify({
          text,
          voice: `modele-${voiceSlug}`,
          speed: speed || 0.95,
        }),
      });

      if (!ttsRes.ok) {
        const errText = await ttsRes.text();
        return { content: [{ type: "text" as const, text: `TTS generation failed: ${ttsRes.status} ${errText}` }], isError: true };
      }

      const ttsData = await ttsRes.json();
      if (!ttsData.success || !ttsData.audioBase64) {
        return { content: [{ type: "text" as const, text: `TTS generation failed: ${ttsData.error || "no audio"}` }], isError: true };
      }

      // 2. Save audio to temp file
      const os = await import("os");
      const fs = await import("fs");
      const path = await import("path");
      const tmpFile = path.join(os.tmpdir(), `ubik-voice-${Date.now()}.wav`);
      const audioBuffer = Buffer.from(ttsData.audioBase64, "base64");
      fs.writeFileSync(tmpFile, audioBuffer);

      // 3. Send audio via WhatsApp (call send_audio_message with media_path)
      const waRes = await fetch(`${baseUrl}/api/tools/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...auth.getAuthHeaders(),
        },
        body: JSON.stringify({
          tool: "send_audio_message",
          input: {
            recipient,
            media_path: tmpFile,
            _ubikUserId: auth.getUserId(),
          },
        }),
      });

      const waData = await waRes.json().catch(() => ({}));

      // Cleanup temp file
      try { fs.unlinkSync(tmpFile); } catch {};

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            message: `Voice message sent to ${recipient} using cloned voice "${voiceSlug}"`,
            audioSize: ttsData.audioBase64.length,
            whatsappResult: waData,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: create_html_artifact ──

server.tool(
  "create_html_artifact",
  `Create a rich, interactive HTML artifact. Supports templates: dashboard, report, presentation, landing, form, kanban, timeline, comparison, diagram, calculator, freeform.
Themes:
- ubik (default): UBIK dark identity — for internal agent reports and dashboards.
- light: Clean professional light theme — for user-facing documents on light backgrounds.
- dark: Modern slate dark theme — for user-facing documents with dark aesthetic.
- corporate: Formal neutral base — adapts to logo colors. Use with logoUrl + accentColor derived from the logo's dominant color.
CDN libs auto-detected: tailwind, alpine, mermaid, echarts, katex, highlightjs, d3, sortable, animate.
Section types: hero, kpi, chart, table, mermaid, code, html, text, tabs, accordion, image, form, timeline, kanban, comparison, calculator, slide.
Logo: When a logo is provided (logoUrl), it is displayed in the header and serves as the graphic charter reference. For corporate theme, derive accentColor from the logo's dominant color.
Examples:
- Dashboard: sections with hero + kpi + chart + table
- Presentation: sections with type "slide" (keyboard nav ← →)
- Kanban: section type "kanban" with columns and cards (drag & drop)
- Calculator: section type "calculator" with fields and formula
- Corporate report: theme "corporate", logoUrl pointing to client logo, accentColor from logo`,
  {
    outputPath: z.string().describe("Absolute path for the HTML output file"),
    title: z.string().optional().describe("Page/artifact title"),
    template: z.enum(["dashboard", "report", "presentation", "landing", "form", "kanban", "timeline", "comparison", "diagram", "calculator", "freeform"]).optional().describe("Template hint (auto-detected from sections if omitted)"),
    theme: z.enum(["ubik", "light", "dark", "corporate"]).optional().describe("Color theme. ubik = UBIK dark identity (default, for agent reports). For user-facing documents: light, dark, or corporate (adapts to logo colors)"),
    libs: z.array(z.string()).optional().describe("Extra CDN libs to load: tailwind, alpine, mermaid, echarts, katex, highlightjs, d3, sortable, animate"),
    logoUrl: z.string().optional().describe("URL, file path, or base64 data URI of a logo image. Displayed in the document header. For 'corporate' theme, use as graphic charter reference to derive accentColor."),
    accentColor: z.string().optional().describe("Override accent color (hex, e.g. '#e74c3c'). For corporate theme, derive from the logo's dominant color to create a branded look."),
    sections: z.string().describe(`JSON array of sections. Each section has a "type" and type-specific fields.
Types & fields:
- hero: { title, subtitle?, background? }
- kpi: { items: [{ label, value, trend?, icon?, color? }] }
- chart: { chartType: "bar"|"barH"|"line"|"pie"|"doughnut"|"radar"|"polarArea"|"heatmap"|"treemap"|"sankey", data: { labels, datasets:[{label,data}] } or ECharts option, title? }
- table: { headers, rows, searchable?, sortable?, title?, caption? }
- mermaid: { code: "graph TD; A-->B" }
- code: { language, content, title? }
- text/html: { title?, content (can include raw HTML) }
- tabs: { items: [{ label, content }], title? }
- accordion: { items: [{ title, content }], title? }
- image: { src, alt?, title? }
- form: { items: [{ name, label, type: "text"|"email"|"number"|"select"|"textarea"|"checkbox", options?, required?, placeholder? }], submitLabel?, title? }
- timeline: { items: [{ date, title, description?, icon?, color? }], title? }
- kanban: { items: [{ title, color?, cards: [{ title, description?, tag? }] }], title? }
- comparison: { items: [{ name, features: { "Feature": value|true|false }, highlight? }], title? }
- calculator: { fields: [{ name, label, default?, min?, max?, step? }], formula: "JS expression using field names", resultLabel?, title? }
- slide: { title, subtitle?, content?, layout?: "center"|"left"|"split", image? }`),
    styles: z.string().optional().describe("Additional custom CSS to inject"),
    scripts: z.string().optional().describe("Additional custom JavaScript to inject"),
  },
  async ({ outputPath, title, template, theme, libs, logoUrl, accentColor, sections: sectionsJson, styles, scripts }) => {
    try {
      const sections = JSON.parse(sectionsJson);
      const input = { template: template as any, title, theme: theme as any, libs: libs as any, sections, styles, scripts, logoUrl, accentColor };

      // Create a canvas session for the HTML artifact
      const { sessionId, emitter } = createCanvasSession();

      const result = await buildHtmlArtifactStreaming(input, outputPath, (event) => {
        emitCanvasEvent(sessionId, event);
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ...result, sessionId }, null, 2) }],
        isError: !result.success,
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Failed to create HTML artifact: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ─── Start ───

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  wrapTransportWithAuth(transport, auth);

  console.error("[UBIK MCP] Skills tools server started (stdio)");
}

main().catch((err) => {
  console.error("[UBIK MCP] Fatal:", err);
  process.exit(1);
});
