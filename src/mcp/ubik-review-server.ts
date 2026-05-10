#!/usr/bin/env node
/**
 * UBIK Code Review — MCP Server (stdio transport)
 *
 * Dedicated MCP server for comprehensive code review, static analysis,
 * security scanning, and complexity analysis. Uses Gemini 2.5 Flash
 * for intelligent AI-augmented review.
 *
 * Tools:
 *   - review_file         → Full review of a single file (static + AI)
 *   - review_diff         → Review staged/unstaged git diff
 *   - review_pr           → Full PR review (commits + diff + AI summary)
 *   - review_security     → Security-focused scan with CWE/OWASP mapping
 *   - review_dependencies → Audit package.json / npm dependencies
 *   - review_complexity   → Cyclomatic complexity & hotspot analysis
 *   - review_summary      → Aggregate health report across multiple files
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { config } from "dotenv";

// Load .env from project root (cwd is set to UBIK root by .mcp.json)
config({ path: path.join(process.cwd(), ".env") });

// ─── Constants ───

const server = new McpServer({ name: "ubik-review", version: "1.0.0" });
const DEFAULT_MODEL = "gemini-3-flash-preview";
const MAX_FILE_SIZE = 500_000;
const MAX_LLM_INPUT = 100_000;

// ─── Types ───

interface LLMResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

interface ReviewIssue {
  severity: "error" | "warning" | "info";
  line: number;
  message: string;
  category: "security" | "performance" | "quality" | "complexity";
  suggestion?: string;
  cwe?: string;
}

interface ComplexityResult {
  file: string;
  functions: {
    name: string;
    line: number;
    cyclomaticComplexity: number;
    nestingDepth: number;
    lines: number;
    parameters: number;
  }[];
  totalLines: number;
  avgComplexity: number;
  maxComplexity: number;
}

// ─── CWE Lookup Table ───

const CWE_MAP: Record<string, { id: string; title: string; owasp?: string }> = {
  "CWE-78": { id: "CWE-78", title: "OS Command Injection", owasp: "A03:2021" },
  "CWE-79": { id: "CWE-79", title: "Cross-site Scripting (XSS)", owasp: "A03:2021" },
  "CWE-89": { id: "CWE-89", title: "SQL Injection", owasp: "A03:2021" },
  "CWE-95": { id: "CWE-95", title: "Eval Injection", owasp: "A03:2021" },
  "CWE-22": { id: "CWE-22", title: "Path Traversal", owasp: "A01:2021" },
  "CWE-330": { id: "CWE-330", title: "Insufficient Randomness", owasp: "A02:2021" },
  "CWE-328": { id: "CWE-328", title: "Weak Hash", owasp: "A02:2021" },
  "CWE-502": { id: "CWE-502", title: "Unsafe Deserialization", owasp: "A08:2021" },
  "CWE-601": { id: "CWE-601", title: "Open Redirect", owasp: "A01:2021" },
  "CWE-798": { id: "CWE-798", title: "Hardcoded Credentials", owasp: "A07:2021" },
  "CWE-942": { id: "CWE-942", title: "Permissive CORS", owasp: "A05:2021" },
};

// ─── Helpers ───

function safeRead(filePath: string): string | null {
  try {
    const stat = statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) return null;
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
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

function gitExec(cmd: string, cwd?: string): string {
  try {
    // Parse the command string into program + args for safe execution
    const parts = cmd.split(/\s+/);
    const program = parts[0];
    const args = parts.slice(1);
    // Always pass cwd to ensure git finds the repo — fallback to process.cwd()
    const gitCwd = cwd || process.env.UBIK_GIT_CWD || process.cwd();
    return execFileSync(program, args, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
      cwd: gitCwd,
      env: { ...process.env, GIT_DISCOVERY_ACROSS_FILESYSTEM: "1" },
    }).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`git command failed: ${cmd} — ${msg}`);
  }
}

function globFiles(basePath: string, extensions?: string[]): string[] {
  const results: string[] = [];
  const exts = extensions ? new Set(extensions.map(e => e.startsWith(".") ? e : `.${e}`)) : null;

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules" || entry === "dist" || entry === "build") continue;
      const full = path.join(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (stat.isFile()) {
          if (!exts || exts.has(path.extname(full).toLowerCase())) {
            results.push(full);
          }
        }
      } catch {
        // skip inaccessible
      }
    }
  }

  walk(basePath);
  return results;
}

// ─── Gemini LLM ───

async function callGemini(system: string, user: string): Promise<LLMResult> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return { text: "", inputTokens: 0, outputTokens: 0 };

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { maxOutputTokens: 4096, temperature: 0.2 },
        }),
      },
    );
    const data = await res.json() as any;
    return {
      text: data.candidates?.[0]?.content?.parts?.[0]?.text || "",
      inputTokens: data.usageMetadata?.promptTokenCount || 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
    };
  } catch (err) {
    console.error("[ubik-review] Gemini call failed:", err);
    return { text: "", inputTokens: 0, outputTokens: 0 };
  }
}

function extractJSON(text: string): any {
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch { /* continue */ }

  // Try extracting from markdown code block
  const jsonBlock = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonBlock) {
    try {
      return JSON.parse(jsonBlock[1].trim());
    } catch { /* continue */ }
  }

  // Try finding first { ... } or [ ... ]
  const braceMatch = text.match(/(\{[\s\S]*\})/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[1]);
    } catch { /* continue */ }
  }

  const bracketMatch = text.match(/(\[[\s\S]*\])/);
  if (bracketMatch) {
    try {
      return JSON.parse(bracketMatch[1]);
    } catch { /* continue */ }
  }

  return null;
}

// ─── Static Analysis Engine ───

function staticAnalysis(content: string, lang: string, focus?: string): ReviewIssue[] {
  const lines = content.split("\n");
  const issues: ReviewIssue[] = [];

  // Security patterns
  const securityPatterns = [
    { regex: /eval\s*\(/, msg: "eval() usage — code injection risk", severity: "error" as const, cwe: "CWE-95", suggestion: "Use safer alternatives like JSON.parse() or Function constructor with validation" },
    { regex: /innerHTML\s*=/, msg: "innerHTML assignment — XSS risk", severity: "error" as const, cwe: "CWE-79", suggestion: "Use textContent or sanitize with DOMPurify" },
    { regex: /dangerouslySetInnerHTML/, msg: "dangerouslySetInnerHTML — XSS risk", severity: "warning" as const, cwe: "CWE-79", suggestion: "Sanitize HTML with DOMPurify before rendering" },
    { regex: /exec(Sync)?\s*\(\s*[`"'].*\$\{/, msg: "Command injection via string interpolation", severity: "error" as const, cwe: "CWE-78", suggestion: "Use execFile() with argument array instead" },
    { regex: /Math\.random\s*\(\)/, msg: "Math.random() is not cryptographically secure", severity: "warning" as const, cwe: "CWE-330", suggestion: "Use crypto.randomBytes() or crypto.randomUUID()" },
    { regex: /(password|secret|token|api[_-]?key)\s*[:=]\s*["'][^"']+["']/, msg: "Hardcoded secret/credential", severity: "error" as const, cwe: "CWE-798", suggestion: "Use environment variables" },
    { regex: /SELECT\s.*FROM\s.*WHERE\s.*[`"']\s*\+/, msg: "SQL injection — string concatenation in query", severity: "error" as const, cwe: "CWE-89", suggestion: "Use parameterized queries" },
    { regex: /res\.redirect\s*\(\s*(req\.|params\.|query\.)/, msg: "Open redirect vulnerability", severity: "warning" as const, cwe: "CWE-601", suggestion: "Validate redirect URL against allowlist" },
    { regex: /\.createReadStream\s*\(\s*(req\.|params\.|query\.)/, msg: "Path traversal risk", severity: "error" as const, cwe: "CWE-22", suggestion: "Validate and sanitize file paths" },
    { regex: /cors\(\s*\)/, msg: "CORS with no restrictions", severity: "warning" as const, cwe: "CWE-942", suggestion: "Specify allowed origins" },
    { regex: /md5|sha1/i, msg: "Weak hash algorithm", severity: "warning" as const, cwe: "CWE-328", suggestion: "Use SHA-256 or bcrypt for passwords" },
    { regex: /JSON\.parse\s*\(\s*(req\.|params\.|body\.)/, msg: "Unsafe JSON deserialization", severity: "warning" as const, cwe: "CWE-502", suggestion: "Validate input schema before parsing" },
  ];

  // Quality patterns
  const qualityPatterns = [
    { regex: /console\.(log|debug|info)\(/, msg: "console.log left in code", severity: "info" as const, category: "quality" as const, suggestion: undefined },
    { regex: /TODO|FIXME|HACK|XXX/, msg: "TODO/FIXME marker found", severity: "info" as const, category: "quality" as const, suggestion: undefined },
    { regex: /:\s*any(\s|;|,|\))/, msg: "Explicit 'any' type", severity: "warning" as const, category: "quality" as const, suggestion: "Use a specific type" },
    { regex: /catch\s*\(\s*\w*\s*\)\s*\{\s*\}/, msg: "Empty catch block", severity: "warning" as const, category: "quality" as const, suggestion: "Handle or log the error" },
    { regex: /\?\s*.*\?\s*.*\?/, msg: "Nested ternary expression", severity: "info" as const, category: "quality" as const, suggestion: "Use if/else for readability" },
  ];

  // Performance patterns
  const performancePatterns = [
    { regex: /await\s+.*\bfor\s*\(|for\s*\(.*await\b/, msg: "Await inside loop — sequential execution", severity: "warning" as const, suggestion: "Use Promise.all() for parallel execution" },
    { regex: /JSON\.parse\(JSON\.stringify/, msg: "JSON deep clone — use structuredClone()", severity: "info" as const, suggestion: "Use structuredClone() (faster, handles more types)" },
    { regex: /\.forEach\(.*async/, msg: "Async forEach — doesn't await iterations", severity: "error" as const, suggestion: "Use for...of with await, or Promise.all with .map" },
    { regex: /new RegExp\(/, msg: "RegExp created in function — consider caching", severity: "info" as const, suggestion: "Move regex to module scope" },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Line length check
    if (line.length > 200) {
      issues.push({ severity: "info", line: lineNum, message: `Line too long (${line.length} chars)`, category: "quality", suggestion: "Break into multiple lines" });
    }

    // Security
    if (!focus || focus === "security" || focus === "all") {
      for (const p of securityPatterns) {
        if (p.regex.test(line)) {
          issues.push({ severity: p.severity, line: lineNum, message: p.msg, category: "security", suggestion: p.suggestion, cwe: p.cwe });
        }
      }
    }

    // Quality
    if (!focus || focus === "quality" || focus === "all") {
      for (const p of qualityPatterns) {
        if (p.regex.test(line)) {
          issues.push({ severity: p.severity, line: lineNum, message: p.msg, category: p.category || "quality", suggestion: p.suggestion });
        }
      }
    }

    // Performance
    if (!focus || focus === "performance" || focus === "all") {
      for (const p of performancePatterns) {
        if (p.regex.test(line)) {
          issues.push({ severity: p.severity, line: lineNum, message: p.msg, category: "performance", suggestion: p.suggestion });
        }
      }
    }
  }

  return issues;
}

// ─── Complexity Analyzer ───

function analyzeComplexity(content: string, filePath: string): ComplexityResult {
  const lines = content.split("\n");
  const functions: ComplexityResult["functions"] = [];

  // Regex patterns to detect function declarations
  const funcPatterns = [
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/,                    // function foo(...)
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*\w+)?\s*=>/, // const foo = (...) =>
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function\s*\(([^)]*)\)/,           // const foo = function(...)
    /(\w+)\s*\(([^)]*)\)\s*(?::\s*[\w<>\[\]|&]+)?\s*\{/,                             // method(...)  { (class method)
  ];

  // Branch keywords that increment cyclomatic complexity
  const branchPatterns = [
    /\bif\s*\(/, /\belse\s+if\s*\(/, /\bcase\s+/, /\bwhile\s*\(/, /\bfor\s*\(/,
    /&&/, /\|\|/, /\?\s*[^:?]/, /\bcatch\s*\(/,
  ];

  let currentFunc: { name: string; line: number; params: string; startBrace: number; braceDepth: number; complexity: number; maxNesting: number; currentNesting: number } | null = null;
  let globalBraceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNum = i + 1;

    // Skip comments and blank lines for function detection
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed === "") {
      continue;
    }

    // Track brace depth
    const openBraces = (line.match(/\{/g) || []).length;
    const closeBraces = (line.match(/\}/g) || []).length;

    // Try to detect function start (only when not already inside a tracked function)
    if (!currentFunc) {
      for (const pattern of funcPatterns) {
        const match = trimmed.match(pattern);
        if (match && match[1] && !["if", "else", "for", "while", "switch", "catch", "return", "new", "import", "export"].includes(match[1])) {
          currentFunc = {
            name: match[1],
            line: lineNum,
            params: match[2] || "",
            startBrace: globalBraceDepth + openBraces,
            braceDepth: globalBraceDepth,
            complexity: 1, // base complexity
            maxNesting: 0,
            currentNesting: 0,
          };
          break;
        }
      }
    }

    // If inside a function, track complexity
    if (currentFunc) {
      // Count branch patterns
      for (const bp of branchPatterns) {
        const matches = line.match(new RegExp(bp.source, "g"));
        if (matches) {
          currentFunc.complexity += matches.length;
        }
      }

      // Track nesting via braces
      if (openBraces > 0) {
        currentFunc.currentNesting += openBraces;
        if (currentFunc.currentNesting > currentFunc.maxNesting) {
          currentFunc.maxNesting = currentFunc.currentNesting;
        }
      }
      if (closeBraces > 0) {
        currentFunc.currentNesting -= closeBraces;
      }

      // Check if function ended
      if (globalBraceDepth + openBraces - closeBraces <= currentFunc.braceDepth && i > 0) {
        const paramCount = currentFunc.params.trim() === "" ? 0 : currentFunc.params.split(",").length;
        functions.push({
          name: currentFunc.name,
          line: currentFunc.line,
          cyclomaticComplexity: currentFunc.complexity,
          nestingDepth: currentFunc.maxNesting,
          lines: lineNum - currentFunc.line + 1,
          parameters: paramCount,
        });
        currentFunc = null;
      }
    }

    globalBraceDepth += openBraces - closeBraces;
  }

  // If a function was still open at EOF, close it
  if (currentFunc) {
    const paramCount = currentFunc.params.trim() === "" ? 0 : currentFunc.params.split(",").length;
    functions.push({
      name: currentFunc.name,
      line: currentFunc.line,
      cyclomaticComplexity: currentFunc.complexity,
      nestingDepth: currentFunc.maxNesting,
      lines: lines.length - currentFunc.line + 1,
      parameters: paramCount,
    });
  }

  const complexities = functions.map(f => f.cyclomaticComplexity);
  const avgComplexity = complexities.length > 0 ? Math.round((complexities.reduce((a, b) => a + b, 0) / complexities.length) * 10) / 10 : 0;
  const maxComplexity = complexities.length > 0 ? Math.max(...complexities) : 0;

  return {
    file: filePath,
    functions,
    totalLines: lines.length,
    avgComplexity,
    maxComplexity,
  };
}

// ─── Scoring Function ───

function computeScores(issues: ReviewIssue[], complexity?: ComplexityResult): {
  security: number; performance: number; readability: number; maintainability: number; overall: number;
} {
  let security = 100, performance = 100, readability = 100, maintainability = 100;

  for (const issue of issues) {
    const penalty = issue.severity === "error" ? 15 : issue.severity === "warning" ? 5 : 1;
    switch (issue.category) {
      case "security": security -= penalty; break;
      case "performance": performance -= penalty; break;
      case "quality": readability -= penalty; break;
      case "complexity": maintainability -= penalty; break;
    }
  }

  if (complexity) {
    if (complexity.maxComplexity > 20) maintainability -= 15;
    else if (complexity.maxComplexity > 10) maintainability -= 5;
    // Penalize deeply nested functions
    for (const fn of complexity.functions) {
      if (fn.nestingDepth > 5) maintainability -= 3;
      if (fn.lines > 100) maintainability -= 3;
      if (fn.parameters > 5) readability -= 2;
    }
  }

  security = Math.max(0, security);
  performance = Math.max(0, performance);
  readability = Math.max(0, readability);
  maintainability = Math.max(0, maintainability);
  const overall = Math.round((security * 0.35 + performance * 0.2 + readability * 0.2 + maintainability * 0.25));

  return { security, performance, readability, maintainability, overall };
}

// ─── Format Helpers ───

function formatIssuesTable(issues: ReviewIssue[]): string {
  if (issues.length === 0) return "No issues found.";
  const rows = issues.map(i => {
    const sev = i.severity === "error" ? "[ERR]" : i.severity === "warning" ? "[WRN]" : "[INF]";
    const cweTag = i.cwe ? ` (${i.cwe})` : "";
    return `  ${sev} L${i.line}: ${i.message}${cweTag}${i.suggestion ? `\n        -> ${i.suggestion}` : ""}`;
  });
  return rows.join("\n");
}

function formatScores(scores: ReturnType<typeof computeScores>): string {
  return [
    `Security:        ${scores.security}/100`,
    `Performance:     ${scores.performance}/100`,
    `Readability:     ${scores.readability}/100`,
    `Maintainability: ${scores.maintainability}/100`,
    `Overall:         ${scores.overall}/100`,
  ].join("\n");
}

// ══════════════════════════════════════════════════════════════════════
// ─── Tool 1: review_file ───
// ══════════════════════════════════════════════════════════════════════

server.tool(
  "review_file",
  "Comprehensive code review of a single file: static analysis, complexity metrics, AI-augmented review, and scoring.",
  {
    path: z.string().describe("Absolute path to the file to review"),
    focus: z.enum(["security", "performance", "quality", "all"]).optional().describe("Focus area (default: all)"),
  },
  async ({ path: filePath, focus }) => {
    const resolvedPath = path.resolve(filePath);
    const content = safeRead(resolvedPath);
    if (!content) {
      return { content: [{ type: "text" as const, text: `Error: Cannot read file or file too large (>${MAX_FILE_SIZE} bytes): ${resolvedPath}` }] };
    }

    const lang = detectLang(resolvedPath);
    const reviewFocus = focus || "all";

    // Static analysis
    const issues = staticAnalysis(content, lang, reviewFocus);

    // Complexity analysis
    const complexity = analyzeComplexity(content, resolvedPath);

    // Compute scores
    const scores = computeScores(issues, complexity);

    // AI review via Gemini
    let aiInsights = "";
    const truncatedContent = content.length > MAX_LLM_INPUT ? content.slice(0, MAX_LLM_INPUT) + "\n... [truncated]" : content;

    const systemPrompt = `You are a senior code reviewer. Analyze the provided ${lang} code.
Focus: ${reviewFocus}.
Static analysis already found these issues:
${issues.slice(0, 20).map(i => `- L${i.line}: ${i.message}`).join("\n")}

Return a JSON object with:
{
  "additional_issues": [{ "line": number, "severity": "error"|"warning"|"info", "message": string, "suggestion": string }],
  "highlights": ["positive aspects of the code"],
  "refactoring_suggestions": ["actionable refactoring ideas"],
  "summary": "2-3 sentence overall assessment"
}`;

    const llmResult = await callGemini(systemPrompt, truncatedContent);
    const aiData = extractJSON(llmResult.text);

    if (aiData) {
      const parts: string[] = [];
      if (aiData.summary) parts.push(`AI Summary: ${aiData.summary}`);
      if (aiData.highlights?.length) parts.push(`Highlights:\n${aiData.highlights.map((h: string) => `  + ${h}`).join("\n")}`);
      if (aiData.refactoring_suggestions?.length) parts.push(`Refactoring:\n${aiData.refactoring_suggestions.map((s: string) => `  * ${s}`).join("\n")}`);
      if (aiData.additional_issues?.length) {
        for (const ai of aiData.additional_issues) {
          issues.push({
            severity: ai.severity || "info",
            line: ai.line || 0,
            message: `[AI] ${ai.message}`,
            category: reviewFocus === "security" ? "security" : reviewFocus === "performance" ? "performance" : "quality",
            suggestion: ai.suggestion,
          });
        }
      }
      aiInsights = parts.join("\n\n");
    }

    // Recompute scores after AI additions
    const finalScores = computeScores(issues, complexity);

    // Format output
    const errorCount = issues.filter(i => i.severity === "error").length;
    const warningCount = issues.filter(i => i.severity === "warning").length;
    const infoCount = issues.filter(i => i.severity === "info").length;

    const output = [
      `═══ UBIK Code Review: ${path.basename(resolvedPath)} ═══`,
      `Language: ${lang} | Focus: ${reviewFocus} | Lines: ${complexity.totalLines}`,
      `Issues: ${errorCount} errors, ${warningCount} warnings, ${infoCount} info`,
      "",
      "── Scores ──",
      formatScores(finalScores),
      "",
      "── Issues ──",
      formatIssuesTable(issues),
      "",
      "── Complexity ──",
      `Functions: ${complexity.functions.length} | Avg CC: ${complexity.avgComplexity} | Max CC: ${complexity.maxComplexity}`,
      ...complexity.functions
        .filter(f => f.cyclomaticComplexity > 5)
        .sort((a, b) => b.cyclomaticComplexity - a.cyclomaticComplexity)
        .slice(0, 10)
        .map(f => `  ${f.name}() L${f.line}: CC=${f.cyclomaticComplexity} depth=${f.nestingDepth} lines=${f.lines} params=${f.parameters}`),
      "",
      aiInsights ? `── AI Insights ──\n${aiInsights}` : "",
      "",
      `[Gemini tokens: ${llmResult.inputTokens} in / ${llmResult.outputTokens} out]`,
    ].filter(Boolean).join("\n");

    return { content: [{ type: "text" as const, text: output }] };
  },
);

// ══════════════════════════════════════════════════════════════════════
// ─── Tool 2: review_diff ───
// ══════════════════════════════════════════════════════════════════════

server.tool(
  "review_diff",
  "Review git diff (staged or unstaged changes). Static analysis on added lines + AI review.",
  {
    target: z.string().optional().describe("Git diff target: 'staged', 'unstaged', or a commit ref (default: unstaged)"),
    baseBranch: z.string().optional().describe("Base branch for comparison (default: HEAD)"),
  },
  async ({ target, baseBranch }) => {
    const diffTarget = target || "unstaged";
    let diffCmd: string;

    if (diffTarget === "staged") {
      diffCmd = "git diff --cached";
    } else if (diffTarget === "unstaged") {
      diffCmd = "git diff";
    } else {
      const base = baseBranch || "HEAD";
      diffCmd = `git diff ${base}...${diffTarget}`;
    }

    let diff: string;
    try {
      diff = gitExec(diffCmd);
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error running diff: ${err instanceof Error ? err.message : String(err)}` }] };
    }

    if (!diff.trim()) {
      return { content: [{ type: "text" as const, text: `No changes found for target: ${diffTarget}` }] };
    }

    // Parse diff per file
    const fileChunks: { file: string; added: string[]; removed: string[]; patch: string }[] = [];
    const fileSections = diff.split(/^diff --git /m).filter(Boolean);

    for (const section of fileSections) {
      const fileMatch = section.match(/a\/(.*?)\s+b\/(.*)/);
      if (!fileMatch) continue;
      const fileName = fileMatch[2];
      const addedLines: string[] = [];
      const removedLines: string[] = [];

      for (const line of section.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) addedLines.push(line.slice(1));
        if (line.startsWith("-") && !line.startsWith("---")) removedLines.push(line.slice(1));
      }

      fileChunks.push({ file: fileName, added: addedLines, removed: removedLines, patch: section.slice(0, 3000) });
    }

    // Static analysis on added lines per file
    const allIssues: { file: string; issues: ReviewIssue[] }[] = [];
    let totalErrors = 0, totalWarnings = 0;

    for (const chunk of fileChunks) {
      const lang = detectLang(chunk.file);
      const addedContent = chunk.added.join("\n");
      const issues = staticAnalysis(addedContent, lang);
      if (issues.length > 0) {
        allIssues.push({ file: chunk.file, issues });
        totalErrors += issues.filter(i => i.severity === "error").length;
        totalWarnings += issues.filter(i => i.severity === "warning").length;
      }
    }

    // AI review of diff
    let aiReview = "";
    const truncatedDiff = diff.length > MAX_LLM_INPUT ? diff.slice(0, MAX_LLM_INPUT) + "\n... [truncated]" : diff;

    const systemPrompt = `You are a senior code reviewer reviewing a git diff.
Analyze the changes for bugs, security issues, performance problems, and code quality.

Return a JSON object:
{
  "risk_level": "low"|"medium"|"high"|"critical",
  "merge_recommendation": "approve"|"request_changes"|"needs_discussion",
  "per_file": [{ "file": string, "risk": "low"|"medium"|"high", "comment": string }],
  "critical_issues": [{ "file": string, "description": string, "suggestion": string }],
  "summary": "2-3 sentence assessment"
}`;

    const llmResult = await callGemini(systemPrompt, truncatedDiff);
    const aiData = extractJSON(llmResult.text);

    if (aiData) {
      const parts: string[] = [];
      if (aiData.summary) parts.push(`Summary: ${aiData.summary}`);
      if (aiData.risk_level) parts.push(`Risk Level: ${aiData.risk_level.toUpperCase()}`);
      if (aiData.merge_recommendation) parts.push(`Recommendation: ${aiData.merge_recommendation}`);
      if (aiData.critical_issues?.length) {
        parts.push("Critical Issues:");
        for (const ci of aiData.critical_issues) {
          parts.push(`  ! ${ci.file}: ${ci.description}`);
          if (ci.suggestion) parts.push(`    -> ${ci.suggestion}`);
        }
      }
      if (aiData.per_file?.length) {
        parts.push("Per-file Assessment:");
        for (const pf of aiData.per_file) {
          parts.push(`  [${pf.risk}] ${pf.file}: ${pf.comment}`);
        }
      }
      aiReview = parts.join("\n");
    }

    // Format output
    const output = [
      `═══ UBIK Diff Review ═══`,
      `Target: ${diffTarget} | Files changed: ${fileChunks.length}`,
      `Static: ${totalErrors} errors, ${totalWarnings} warnings`,
      "",
      "── Changed Files ──",
      ...fileChunks.map(c => `  ${c.file}: +${c.added.length} -${c.removed.length} lines`),
      "",
      allIssues.length > 0 ? "── Static Issues (added lines) ──" : "",
      ...allIssues.map(fi => `  ${fi.file}:\n${formatIssuesTable(fi.issues)}`),
      "",
      aiReview ? `── AI Review ──\n${aiReview}` : "",
      "",
      `[Gemini tokens: ${llmResult.inputTokens} in / ${llmResult.outputTokens} out]`,
    ].filter(Boolean).join("\n");

    return { content: [{ type: "text" as const, text: output }] };
  },
);

// ══════════════════════════════════════════════════════════════════════
// ─── Tool 3: review_pr ───
// ══════════════════════════════════════════════════════════════════════

server.tool(
  "review_pr",
  "Full pull request review: commit history, diff analysis, architecture impact, test coverage, and merge recommendation.",
  {
    branch: z.string().describe("Branch name to review"),
    baseBranch: z.string().optional().describe("Base branch (default: main)"),
  },
  async ({ branch, baseBranch }) => {
    const base = baseBranch || "main";

    // Get commit log
    let commitLog: string;
    try {
      commitLog = gitExec(`git log ${base}..${branch} --oneline --no-decorate`);
    } catch {
      try {
        commitLog = gitExec(`git log origin/${base}..${branch} --oneline --no-decorate`);
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: Cannot get commit log for ${branch} vs ${base}: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    }

    // Get diff
    let diff: string;
    try {
      diff = gitExec(`git diff ${base}...${branch}`);
    } catch {
      try {
        diff = gitExec(`git diff origin/${base}...${branch}`);
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: Cannot get diff for ${branch} vs ${base}: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    }

    // Get diff stats
    let diffStat: string;
    try {
      diffStat = gitExec(`git diff ${base}...${branch} --stat`);
    } catch {
      diffStat = gitExec(`git diff origin/${base}...${branch} --stat`);
    }

    const commits = commitLog.split("\n").filter(Boolean);

    // Parse changed files from diff
    const changedFiles: string[] = [];
    const fileMatches = diff.matchAll(/^diff --git a\/(.*?) b\/(.*)/gm);
    for (const m of fileMatches) {
      changedFiles.push(m[2]);
    }

    // Static analysis on the diff
    const fileChunks: { file: string; addedContent: string }[] = [];
    const fileSections = diff.split(/^diff --git /m).filter(Boolean);
    for (const section of fileSections) {
      const fileMatch = section.match(/a\/(.*?)\s+b\/(.*)/);
      if (!fileMatch) continue;
      const addedLines: string[] = [];
      for (const line of section.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) addedLines.push(line.slice(1));
      }
      fileChunks.push({ file: fileMatch[2], addedContent: addedLines.join("\n") });
    }

    let totalIssues: ReviewIssue[] = [];
    for (const chunk of fileChunks) {
      const lang = detectLang(chunk.file);
      const issues = staticAnalysis(chunk.addedContent, lang);
      totalIssues = totalIssues.concat(issues.map(i => ({ ...i, message: `${chunk.file}: ${i.message}` })));
    }

    // Check for test files
    const hasTests = changedFiles.some(f => /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(f) || f.includes("__tests__"));
    const hasOnlyCodeChanges = changedFiles.some(f => /\.(ts|tsx|js|jsx|py|go|rs)$/.test(f) && !/\.(test|spec)\./.test(f));

    // AI PR review
    const truncatedDiff = diff.length > MAX_LLM_INPUT ? diff.slice(0, MAX_LLM_INPUT) + "\n... [truncated]" : diff;

    const systemPrompt = `You are a senior engineer reviewing a pull request.
Branch: ${branch} -> ${base}
Commits: ${commits.length}
Changed files: ${changedFiles.length}
Test files included: ${hasTests ? "yes" : "no"}

Analyze the PR holistically. Return JSON:
{
  "pr_summary": "what this PR does in 2-3 sentences",
  "architecture_impact": "low"|"medium"|"high",
  "architecture_notes": "explain any architectural concerns",
  "test_coverage_assessment": "adequate"|"needs_improvement"|"missing",
  "test_suggestions": ["specific test suggestions"],
  "breaking_changes": ["list any breaking changes"],
  "recommendation": "approve"|"request_changes"|"needs_discussion",
  "key_concerns": ["top concerns"],
  "positive_aspects": ["good things about this PR"]
}`;

    const userPrompt = `Commits:\n${commitLog}\n\nDiff stats:\n${diffStat}\n\nDiff:\n${truncatedDiff}`;
    const llmResult = await callGemini(systemPrompt, userPrompt);
    const aiData = extractJSON(llmResult.text);

    // Format output
    const errorCount = totalIssues.filter(i => i.severity === "error").length;
    const warningCount = totalIssues.filter(i => i.severity === "warning").length;

    const outputParts = [
      `═══ UBIK PR Review: ${branch} -> ${base} ═══`,
      `Commits: ${commits.length} | Files changed: ${changedFiles.length}`,
      `Static: ${errorCount} errors, ${warningCount} warnings`,
      `Tests included: ${hasTests ? "Yes" : "No"}${!hasTests && hasOnlyCodeChanges ? " (MISSING — code changes without tests)" : ""}`,
      "",
      "── Commits ──",
      commitLog,
      "",
      "── Diff Stats ──",
      diffStat,
    ];

    if (totalIssues.filter(i => i.severity === "error").length > 0) {
      outputParts.push("", "── Critical Static Issues ──");
      outputParts.push(formatIssuesTable(totalIssues.filter(i => i.severity === "error")));
    }

    if (aiData) {
      outputParts.push("", "── AI PR Assessment ──");
      if (aiData.pr_summary) outputParts.push(`Summary: ${aiData.pr_summary}`);
      if (aiData.recommendation) outputParts.push(`Recommendation: ${aiData.recommendation.toUpperCase()}`);
      if (aiData.architecture_impact) outputParts.push(`Architecture Impact: ${aiData.architecture_impact}`);
      if (aiData.architecture_notes) outputParts.push(`Architecture Notes: ${aiData.architecture_notes}`);
      if (aiData.test_coverage_assessment) outputParts.push(`Test Coverage: ${aiData.test_coverage_assessment}`);
      if (aiData.test_suggestions?.length) {
        outputParts.push("Test Suggestions:");
        for (const ts of aiData.test_suggestions) outputParts.push(`  - ${ts}`);
      }
      if (aiData.breaking_changes?.length) {
        outputParts.push("Breaking Changes:");
        for (const bc of aiData.breaking_changes) outputParts.push(`  ! ${bc}`);
      }
      if (aiData.key_concerns?.length) {
        outputParts.push("Key Concerns:");
        for (const kc of aiData.key_concerns) outputParts.push(`  * ${kc}`);
      }
      if (aiData.positive_aspects?.length) {
        outputParts.push("Positive Aspects:");
        for (const pa of aiData.positive_aspects) outputParts.push(`  + ${pa}`);
      }
    }

    outputParts.push("", `[Gemini tokens: ${llmResult.inputTokens} in / ${llmResult.outputTokens} out]`);

    return { content: [{ type: "text" as const, text: outputParts.join("\n") }] };
  },
);

// ══════════════════════════════════════════════════════════════════════
// ─── Tool 4: review_security ───
// ══════════════════════════════════════════════════════════════════════

server.tool(
  "review_security",
  "Security-focused scan with CWE/OWASP mapping. Scans a file or directory for vulnerabilities.",
  {
    path: z.string().describe("Absolute path to a file or directory to scan"),
  },
  async ({ path: targetPath }) => {
    const resolvedPath = path.resolve(targetPath);
    const isDir = existsSync(resolvedPath) && statSync(resolvedPath).isDirectory();

    const filesToScan: string[] = [];
    if (isDir) {
      const codeExts = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".php", ".rb"];
      filesToScan.push(...globFiles(resolvedPath, codeExts).slice(0, 100));
    } else {
      filesToScan.push(resolvedPath);
    }

    if (filesToScan.length === 0) {
      return { content: [{ type: "text" as const, text: "No scannable files found." }] };
    }

    // Scan all files (security focus only)
    const allVulns: { file: string; issues: ReviewIssue[] }[] = [];
    let totalErrors = 0, totalWarnings = 0;
    const cweHits: Record<string, number> = {};

    for (const file of filesToScan) {
      const content = safeRead(file);
      if (!content) continue;
      const lang = detectLang(file);
      const issues = staticAnalysis(content, lang, "security");
      if (issues.length > 0) {
        allVulns.push({ file, issues });
        totalErrors += issues.filter(i => i.severity === "error").length;
        totalWarnings += issues.filter(i => i.severity === "warning").length;
        for (const i of issues) {
          if (i.cwe) cweHits[i.cwe] = (cweHits[i.cwe] || 0) + 1;
        }
      }
    }

    // CWE/OWASP summary
    const cweSummary = Object.entries(cweHits)
      .sort((a, b) => b[1] - a[1])
      .map(([cwe, count]) => {
        const info = CWE_MAP[cwe];
        return info
          ? `  ${cwe} — ${info.title} (${count}x)${info.owasp ? ` [OWASP ${info.owasp}]` : ""}`
          : `  ${cwe} (${count}x)`;
      });

    // AI security analysis (only if there are findings)
    let aiAnalysis = "";
    if (allVulns.length > 0) {
      const vulnSummary = allVulns
        .flatMap(v => v.issues.map(i => `${v.file}: L${i.line} ${i.message} ${i.cwe || ""}`))
        .slice(0, 50)
        .join("\n");

      // Include a sample of code if single file
      let codeContext = "";
      if (!isDir && filesToScan.length === 1) {
        const content = safeRead(filesToScan[0]);
        if (content) {
          codeContext = content.length > MAX_LLM_INPUT ? content.slice(0, MAX_LLM_INPUT) : content;
        }
      }

      const systemPrompt = `You are a security auditor performing OWASP Top 10 analysis.
Static scan found these vulnerabilities:
${vulnSummary}

Return JSON:
{
  "risk_rating": "low"|"medium"|"high"|"critical",
  "owasp_categories": [{ "category": "A01:2021 Broken Access Control", "findings": number, "notes": string }],
  "critical_vulnerabilities": [{ "description": string, "file": string, "remediation": string, "priority": "immediate"|"high"|"medium" }],
  "security_recommendations": ["actionable recommendations"],
  "summary": "overall security posture assessment"
}`;

      const llmResult = await callGemini(systemPrompt, codeContext || vulnSummary);
      const aiData = extractJSON(llmResult.text);

      if (aiData) {
        const parts: string[] = [];
        if (aiData.risk_rating) parts.push(`Risk Rating: ${aiData.risk_rating.toUpperCase()}`);
        if (aiData.summary) parts.push(`Assessment: ${aiData.summary}`);
        if (aiData.owasp_categories?.length) {
          parts.push("OWASP Top 10 Mapping:");
          for (const cat of aiData.owasp_categories) {
            if (cat.findings > 0) parts.push(`  ${cat.category}: ${cat.findings} finding(s) — ${cat.notes}`);
          }
        }
        if (aiData.critical_vulnerabilities?.length) {
          parts.push("Critical Vulnerabilities:");
          for (const cv of aiData.critical_vulnerabilities) {
            parts.push(`  [${cv.priority}] ${cv.description}`);
            parts.push(`    File: ${cv.file}`);
            parts.push(`    Fix: ${cv.remediation}`);
          }
        }
        if (aiData.security_recommendations?.length) {
          parts.push("Recommendations:");
          for (const r of aiData.security_recommendations) parts.push(`  - ${r}`);
        }
        aiAnalysis = parts.join("\n");
      }
    }

    // Format output
    const output = [
      `═══ UBIK Security Scan ═══`,
      `Target: ${resolvedPath}`,
      `Files scanned: ${filesToScan.length} | Vulnerabilities: ${totalErrors} errors, ${totalWarnings} warnings`,
      "",
      cweSummary.length > 0 ? "── CWE/OWASP References ──" : "",
      ...cweSummary,
      "",
      "── Vulnerabilities by File ──",
      ...allVulns.map(v => `  ${v.file}:\n${formatIssuesTable(v.issues)}`),
      "",
      aiAnalysis ? `── AI Security Analysis ──\n${aiAnalysis}` : "",
    ].filter(Boolean).join("\n");

    return { content: [{ type: "text" as const, text: output }] };
  },
);

// ══════════════════════════════════════════════════════════════════════
// ─── Tool 5: review_dependencies ───
// ══════════════════════════════════════════════════════════════════════

server.tool(
  "review_dependencies",
  "Audit package.json dependencies: check for vulnerabilities via npm audit, outdated packages, and license issues.",
  {
    path: z.string().optional().describe("Path to project directory containing package.json (default: cwd)"),
  },
  async ({ path: projectPath }) => {
    const dir = projectPath ? path.resolve(projectPath) : process.cwd();
    const pkgPath = path.join(dir, "package.json");

    if (!existsSync(pkgPath)) {
      return { content: [{ type: "text" as const, text: `Error: No package.json found at ${pkgPath}` }] };
    }

    const pkgContent = safeRead(pkgPath);
    if (!pkgContent) {
      return { content: [{ type: "text" as const, text: `Error: Cannot read ${pkgPath}` }] };
    }

    let pkg: any;
    try {
      pkg = JSON.parse(pkgContent);
    } catch {
      return { content: [{ type: "text" as const, text: `Error: Invalid JSON in ${pkgPath}` }] };
    }

    const deps = Object.entries(pkg.dependencies || {});
    const devDeps = Object.entries(pkg.devDependencies || {});

    // Run npm audit
    let auditData: any = null;
    try {
      const auditOutput = execFileSync("npm", ["audit", "--json"], { cwd: dir, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024, timeout: 60_000, stdio: ["pipe", "pipe", "pipe"] });
      auditData = JSON.parse(auditOutput);
    } catch (err: any) {
      // npm audit exits with non-zero when vulnerabilities found
      if (err.stdout) {
        try {
          auditData = JSON.parse(err.stdout);
        } catch { /* ignore parse failure */ }
      }
    }

    // Parse audit results
    const vulns: { name: string; severity: string; title: string; url: string; range: string }[] = [];
    if (auditData?.vulnerabilities) {
      for (const [name, info] of Object.entries(auditData.vulnerabilities) as [string, any][]) {
        vulns.push({
          name,
          severity: info.severity || "unknown",
          title: info.via?.[0]?.title || info.via?.[0] || "unknown",
          url: info.via?.[0]?.url || "",
          range: info.range || "",
        });
      }
    }

    // Severity counts
    const sevCounts: Record<string, number> = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
    for (const v of vulns) {
      sevCounts[v.severity] = (sevCounts[v.severity] || 0) + 1;
    }

    // Check for risky patterns in dependencies
    const warnings: string[] = [];
    for (const [name, version] of deps) {
      const ver = String(version);
      if (ver === "*" || ver === "latest") {
        warnings.push(`${name}@${ver} — unpinned version, use exact or range`);
      }
      if (ver.startsWith("git") || ver.startsWith("http")) {
        warnings.push(`${name} — git/url dependency, not auditable`);
      }
    }

    // Check for lockfile
    const hasLockfile = existsSync(path.join(dir, "package-lock.json")) || existsSync(path.join(dir, "yarn.lock")) || existsSync(path.join(dir, "pnpm-lock.yaml"));
    if (!hasLockfile) {
      warnings.push("No lockfile found — dependency versions are not deterministic");
    }

    // Format output
    const output = [
      `═══ UBIK Dependency Audit ═══`,
      `Project: ${pkg.name || path.basename(dir)} @ ${pkg.version || "unknown"}`,
      `Dependencies: ${deps.length} prod, ${devDeps.length} dev`,
      `Lockfile: ${hasLockfile ? "present" : "MISSING"}`,
      "",
      "── npm audit ──",
      auditData
        ? `Critical: ${sevCounts.critical} | High: ${sevCounts.high} | Moderate: ${sevCounts.moderate} | Low: ${sevCounts.low}`
        : "npm audit could not be run (missing node_modules?)",
      "",
      ...(vulns.filter(v => v.severity === "critical" || v.severity === "high").length > 0
        ? [
          "── High/Critical Vulnerabilities ──",
          ...vulns
            .filter(v => v.severity === "critical" || v.severity === "high")
            .map(v => `  [${v.severity.toUpperCase()}] ${v.name}${v.range ? `@${v.range}` : ""}: ${typeof v.title === "string" ? v.title : v.name}${v.url ? `\n    ${v.url}` : ""}`),
          "",
        ]
        : []),
      ...(vulns.filter(v => v.severity === "moderate").length > 0
        ? [
          "── Moderate Vulnerabilities ──",
          ...vulns
            .filter(v => v.severity === "moderate")
            .map(v => `  [MOD] ${v.name}: ${typeof v.title === "string" ? v.title : v.name}`),
          "",
        ]
        : []),
      ...(warnings.length > 0
        ? ["── Warnings ──", ...warnings.map(w => `  ! ${w}`), ""]
        : []),
      "── Dependencies ──",
      ...deps.slice(0, 30).map(([n, v]) => `  ${n}: ${v}`),
      deps.length > 30 ? `  ... and ${deps.length - 30} more` : "",
    ].filter(Boolean).join("\n");

    return { content: [{ type: "text" as const, text: output }] };
  },
);

// ══════════════════════════════════════════════════════════════════════
// ─── Tool 6: review_complexity ───
// ══════════════════════════════════════════════════════════════════════

server.tool(
  "review_complexity",
  "Analyze cyclomatic complexity, nesting depth, and function length. Returns hotspots sorted by risk.",
  {
    path: z.string().describe("Absolute path to a file or directory to analyze"),
  },
  async ({ path: targetPath }) => {
    const resolvedPath = path.resolve(targetPath);
    const isDir = existsSync(resolvedPath) && statSync(resolvedPath).isDirectory();

    const filesToAnalyze: string[] = [];
    if (isDir) {
      const codeExts = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java"];
      filesToAnalyze.push(...globFiles(resolvedPath, codeExts).slice(0, 100));
    } else {
      filesToAnalyze.push(resolvedPath);
    }

    if (filesToAnalyze.length === 0) {
      return { content: [{ type: "text" as const, text: "No analyzable files found." }] };
    }

    const results: ComplexityResult[] = [];
    let totalFunctions = 0;
    let totalLines = 0;
    let globalMaxCC = 0;
    let globalMaxCCFunc = "";
    let globalMaxCCFile = "";

    for (const file of filesToAnalyze) {
      const content = safeRead(file);
      if (!content) continue;

      const result = analyzeComplexity(content, file);
      results.push(result);
      totalFunctions += result.functions.length;
      totalLines += result.totalLines;

      for (const fn of result.functions) {
        if (fn.cyclomaticComplexity > globalMaxCC) {
          globalMaxCC = fn.cyclomaticComplexity;
          globalMaxCCFunc = fn.name;
          globalMaxCCFile = file;
        }
      }
    }

    // Collect all functions and sort by complexity (hotspots)
    const allFunctions = results.flatMap(r => r.functions.map(f => ({ ...f, file: r.file })));
    const hotspots = allFunctions
      .filter(f => f.cyclomaticComplexity > 3)
      .sort((a, b) => b.cyclomaticComplexity - a.cyclomaticComplexity)
      .slice(0, 30);

    // Risk categories
    const critical = hotspots.filter(f => f.cyclomaticComplexity > 20);
    const high = hotspots.filter(f => f.cyclomaticComplexity > 10 && f.cyclomaticComplexity <= 20);
    const medium = hotspots.filter(f => f.cyclomaticComplexity > 5 && f.cyclomaticComplexity <= 10);

    // Long functions
    const longFunctions = allFunctions
      .filter(f => f.lines > 50)
      .sort((a, b) => b.lines - a.lines)
      .slice(0, 15);

    // Deep nesting
    const deepNesting = allFunctions
      .filter(f => f.nestingDepth > 4)
      .sort((a, b) => b.nestingDepth - a.nestingDepth)
      .slice(0, 15);

    // Many parameters
    const manyParams = allFunctions
      .filter(f => f.parameters > 4)
      .sort((a, b) => b.parameters - a.parameters)
      .slice(0, 15);

    // Overall averages
    const avgCC = allFunctions.length > 0
      ? Math.round((allFunctions.reduce((s, f) => s + f.cyclomaticComplexity, 0) / allFunctions.length) * 10) / 10
      : 0;

    // Format output
    const formatFunc = (f: typeof hotspots[0]) =>
      `  ${f.name}() [${path.basename(f.file)}:${f.line}] CC=${f.cyclomaticComplexity} depth=${f.nestingDepth} lines=${f.lines} params=${f.parameters}`;

    const output = [
      `═══ UBIK Complexity Analysis ═══`,
      `Target: ${resolvedPath}`,
      `Files: ${results.length} | Functions: ${totalFunctions} | Lines: ${totalLines}`,
      `Avg CC: ${avgCC} | Max CC: ${globalMaxCC} (${globalMaxCCFunc}() in ${path.basename(globalMaxCCFile)})`,
      "",
      ...(critical.length > 0 ? ["── CRITICAL (CC > 20) — Must refactor ──", ...critical.map(formatFunc), ""] : []),
      ...(high.length > 0 ? ["── HIGH (CC 11-20) — Should refactor ──", ...high.map(formatFunc), ""] : []),
      ...(medium.length > 0 ? ["── MEDIUM (CC 6-10) — Consider simplifying ──", ...medium.map(formatFunc), ""] : []),
      ...(longFunctions.length > 0 ? ["── Long Functions (> 50 lines) ──", ...longFunctions.map(formatFunc), ""] : []),
      ...(deepNesting.length > 0 ? ["── Deep Nesting (> 4 levels) ──", ...deepNesting.map(formatFunc), ""] : []),
      ...(manyParams.length > 0 ? ["── Many Parameters (> 4) ──", ...manyParams.map(formatFunc), ""] : []),
      "── Per-file Summary ──",
      ...results
        .filter(r => r.functions.length > 0)
        .sort((a, b) => b.maxComplexity - a.maxComplexity)
        .slice(0, 30)
        .map(r => `  ${path.basename(r.file)}: ${r.functions.length} funcs, avg CC=${r.avgComplexity}, max CC=${r.maxComplexity}, ${r.totalLines} lines`),
    ].join("\n");

    return { content: [{ type: "text" as const, text: output }] };
  },
);

// ══════════════════════════════════════════════════════════════════════
// ─── Tool 7: review_summary ───
// ══════════════════════════════════════════════════════════════════════

server.tool(
  "review_summary",
  "Aggregate health report across multiple files or a directory. Computes overall scores, top issues, and priority actions.",
  {
    paths: z.array(z.string()).describe("Array of absolute file or directory paths to scan"),
  },
  async ({ paths: targetPaths }) => {
    const allFiles: string[] = [];
    const codeExts = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".php", ".rb"];

    for (const p of targetPaths) {
      const resolved = path.resolve(p);
      if (!existsSync(resolved)) continue;
      if (statSync(resolved).isDirectory()) {
        allFiles.push(...globFiles(resolved, codeExts));
      } else {
        allFiles.push(resolved);
      }
    }

    // Cap at 200 files
    const filesToScan = allFiles.slice(0, 200);

    if (filesToScan.length === 0) {
      return { content: [{ type: "text" as const, text: "No scannable files found in provided paths." }] };
    }

    // Analyze all files
    const fileResults: { file: string; issues: ReviewIssue[]; complexity: ComplexityResult; scores: ReturnType<typeof computeScores> }[] = [];
    let totalIssues = 0;
    let totalErrors = 0;
    let totalWarnings = 0;
    let totalLines = 0;
    const categoryCounts: Record<string, number> = { security: 0, performance: 0, quality: 0, complexity: 0 };

    for (const file of filesToScan) {
      const content = safeRead(file);
      if (!content) continue;

      const lang = detectLang(file);
      const issues = staticAnalysis(content, lang, "all");
      const complexity = analyzeComplexity(content, file);
      const scores = computeScores(issues, complexity);

      fileResults.push({ file, issues, complexity, scores });

      totalIssues += issues.length;
      totalErrors += issues.filter(i => i.severity === "error").length;
      totalWarnings += issues.filter(i => i.severity === "warning").length;
      totalLines += complexity.totalLines;

      for (const issue of issues) {
        categoryCounts[issue.category] = (categoryCounts[issue.category] || 0) + 1;
      }
    }

    // Aggregate scores
    const avgScores = {
      security: 0, performance: 0, readability: 0, maintainability: 0, overall: 0,
    };
    if (fileResults.length > 0) {
      for (const fr of fileResults) {
        avgScores.security += fr.scores.security;
        avgScores.performance += fr.scores.performance;
        avgScores.readability += fr.scores.readability;
        avgScores.maintainability += fr.scores.maintainability;
        avgScores.overall += fr.scores.overall;
      }
      const n = fileResults.length;
      avgScores.security = Math.round(avgScores.security / n);
      avgScores.performance = Math.round(avgScores.performance / n);
      avgScores.readability = Math.round(avgScores.readability / n);
      avgScores.maintainability = Math.round(avgScores.maintainability / n);
      avgScores.overall = Math.round(avgScores.overall / n);
    }

    // Worst files
    const worstFiles = fileResults
      .sort((a, b) => a.scores.overall - b.scores.overall)
      .slice(0, 10);

    // Most common issues
    const issueCounts: Record<string, number> = {};
    for (const fr of fileResults) {
      for (const issue of fr.issues) {
        issueCounts[issue.message] = (issueCounts[issue.message] || 0) + 1;
      }
    }
    const topIssues = Object.entries(issueCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);

    // Health grade
    const grade = avgScores.overall >= 90 ? "A" : avgScores.overall >= 80 ? "B" : avgScores.overall >= 70 ? "C" : avgScores.overall >= 60 ? "D" : "F";

    // AI summary
    let aiSummary = "";
    const summaryData = {
      files: filesToScan.length,
      totalLines,
      totalErrors,
      totalWarnings,
      avgScores,
      categoryCounts,
      topIssues: topIssues.slice(0, 10),
      worstFiles: worstFiles.slice(0, 5).map(f => ({ file: path.basename(f.file), score: f.scores.overall, errors: f.issues.filter(i => i.severity === "error").length })),
    };

    const systemPrompt = `You are a tech lead reviewing a codebase health report.
Given this data, provide actionable prioritized recommendations.

Return JSON:
{
  "health_assessment": "1-2 sentence overall health summary",
  "priority_actions": [{ "action": string, "impact": "high"|"medium"|"low", "effort": "low"|"medium"|"high" }],
  "technical_debt_estimate": "low"|"medium"|"high"|"critical",
  "strengths": ["positive aspects"],
  "risks": ["key risks to address"]
}`;

    const llmResult = await callGemini(systemPrompt, JSON.stringify(summaryData, null, 2));
    const aiData = extractJSON(llmResult.text);

    if (aiData) {
      const parts: string[] = [];
      if (aiData.health_assessment) parts.push(`Assessment: ${aiData.health_assessment}`);
      if (aiData.technical_debt_estimate) parts.push(`Tech Debt: ${aiData.technical_debt_estimate.toUpperCase()}`);
      if (aiData.strengths?.length) {
        parts.push("Strengths:");
        for (const s of aiData.strengths) parts.push(`  + ${s}`);
      }
      if (aiData.risks?.length) {
        parts.push("Risks:");
        for (const r of aiData.risks) parts.push(`  ! ${r}`);
      }
      if (aiData.priority_actions?.length) {
        parts.push("Priority Actions:");
        for (const a of aiData.priority_actions) {
          parts.push(`  [${a.impact} impact / ${a.effort} effort] ${a.action}`);
        }
      }
      aiSummary = parts.join("\n");
    }

    // Format output
    const output = [
      `═══ UBIK Codebase Health Report ═══`,
      `Grade: ${grade} (${avgScores.overall}/100)`,
      `Files: ${filesToScan.length} | Lines: ${totalLines} | Issues: ${totalIssues} (${totalErrors} errors, ${totalWarnings} warnings)`,
      "",
      "── Scores ──",
      `Security:        ${avgScores.security}/100`,
      `Performance:     ${avgScores.performance}/100`,
      `Readability:     ${avgScores.readability}/100`,
      `Maintainability: ${avgScores.maintainability}/100`,
      `Overall:         ${avgScores.overall}/100`,
      "",
      "── Issue Breakdown ──",
      `Security:    ${categoryCounts.security}`,
      `Performance: ${categoryCounts.performance}`,
      `Quality:     ${categoryCounts.quality}`,
      `Complexity:  ${categoryCounts.complexity}`,
      "",
      "── Most Common Issues ──",
      ...topIssues.map(([msg, count]) => `  (${count}x) ${msg}`),
      "",
      "── Worst Files ──",
      ...worstFiles.map(f => {
        const errs = f.issues.filter(i => i.severity === "error").length;
        const warns = f.issues.filter(i => i.severity === "warning").length;
        return `  ${path.basename(f.file)}: ${f.scores.overall}/100 (${errs}E ${warns}W)`;
      }),
      "",
      aiSummary ? `── AI Summary ──\n${aiSummary}` : "",
      "",
      `[Gemini tokens: ${llmResult.inputTokens} in / ${llmResult.outputTokens} out]`,
    ].filter(Boolean).join("\n");

    return { content: [{ type: "text" as const, text: output }] };
  },
);

// ══════════════════════════════════════════════════════════════════════
// ─── Server Startup ───
// ══════════════════════════════════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[ubik-review] Code Review MCP server started");
}

main().catch((err) => {
  console.error("[ubik-review] Fatal:", err);
  process.exit(1);
});
