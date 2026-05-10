/**
 * HTML Artifact Builder — Generate rich, interactive HTML artifacts from structured data.
 * Supports templates (dashboard, report, presentation, etc.), CDN libs (Tailwind, Alpine, Mermaid, ECharts),
 * and themed output (ubik dark, light, dark, corporate).
 *
 * Theme system:
 * - "ubik"      → Internal UBIK dark identity (#0c0c14). Used for agent reports.
 * - "light"     → Clean professional light theme. User-facing documents.
 * - "dark"      → Modern slate dark theme. User-facing documents.
 * - "corporate" → Formal, neutral base. Adapts to logo colors via accentColor override.
 * - "cyberpunk" → Deprecated alias for "ubik".
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

// ─── Types ───

export type ArtifactTheme = "ubik" | "light" | "dark" | "corporate" | "cyberpunk";
export type ArtifactTemplate =
  | "dashboard" | "report" | "presentation" | "landing"
  | "form" | "kanban" | "timeline" | "comparison"
  | "diagram" | "calculator" | "freeform";

export type ArtifactLib =
  | "tailwind" | "alpine" | "mermaid" | "echarts"
  | "katex" | "highlightjs" | "threejs" | "d3"
  | "sortable" | "animate";

export interface ArtifactSection {
  type: "hero" | "kpi" | "chart" | "table" | "mermaid" | "code"
      | "html" | "tabs" | "accordion" | "text" | "image" | "form"
      | "timeline" | "kanban" | "comparison" | "calculator" | "slide";
  // Hero
  title?: string;
  subtitle?: string;
  background?: string;
  // KPI
  items?: KpiItem[] | TabItem[] | AccordionItem[] | TimelineItem[] | KanbanColumn[] | ComparisonItem[] | FormField[];
  // Chart
  chartType?: string;
  data?: unknown;
  // Table
  headers?: string[];
  rows?: (string | number)[][];
  searchable?: boolean;
  sortable?: boolean;
  caption?: string;
  // Mermaid
  code?: string;
  // Code block
  language?: string;
  content?: string;
  // Tabs / Accordion items use `items`
  // Text / HTML
  // text reuses `content`
  // Image
  src?: string;
  alt?: string;
  // Form fields use `items`
  submitLabel?: string;
  // Calculator
  fields?: CalcField[];
  formula?: string;
  resultLabel?: string;
  // Slide (presentation)
  // reuses title, subtitle, content
  layout?: "center" | "left" | "split";
  image?: string;
}

export interface KpiItem { label: string; value: string | number; trend?: string; icon?: string; color?: string }
export interface TabItem { label: string; content: string }
export interface AccordionItem { title: string; content: string }
export interface TimelineItem { date: string; title: string; description?: string; icon?: string; color?: string }
export interface KanbanColumn { title: string; color?: string; cards: { title: string; description?: string; tag?: string }[] }
export interface ComparisonItem { name: string; features: Record<string, string | boolean | number>; highlight?: boolean }
export interface FormField { name: string; label: string; type: "text" | "email" | "number" | "select" | "textarea" | "checkbox"; options?: string[]; required?: boolean; placeholder?: string }
export interface CalcField { name: string; label: string; default?: number; min?: number; max?: number; step?: number }

export interface ArtifactInput {
  template?: ArtifactTemplate;
  title?: string;
  theme?: ArtifactTheme;
  libs?: ArtifactLib[];
  sections: ArtifactSection[];
  scripts?: string;
  styles?: string;
  /** URL, file path, or base64 data URI for logo. Displayed in header, used as graphic charter reference. */
  logoUrl?: string;
  /** Override accent color (hex). For corporate theme, derive from the logo's dominant color. */
  accentColor?: string;
}

interface BuildResult {
  success: boolean;
  output?: string;
  error?: string;
  path?: string;
  size?: number;
}

// ─── CDN URLs ───

const CDN: Record<ArtifactLib, { css?: string; js?: string }> = {
  tailwind:    { js: "https://cdn.tailwindcss.com" },
  alpine:      { js: "https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js" },
  mermaid:     { js: "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js" },
  echarts:     { js: "https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js" },
  katex:       { css: "https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.css", js: "https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.js" },
  highlightjs: { css: "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github-dark.min.css", js: "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/highlight.min.js" },
  threejs:     { js: "https://cdn.jsdelivr.net/npm/three@0.160/build/three.min.js" },
  d3:          { js: "https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js" },
  sortable:    { js: "https://cdn.jsdelivr.net/npm/sortablejs@1/Sortable.min.js" },
  animate:     { css: "https://cdn.jsdelivr.net/npm/animate.css@4/animate.min.css" },
};

// ─── Theme palettes ───

const THEMES: Record<ArtifactTheme, { bg: string; surface: string; text: string; muted: string; accent: string; accentAlt: string; border: string; code: string }> = {
  // UBIK internal dark identity — matches agent templates (#0c0c14 / #12121e)
  ubik: {
    bg: "#0c0c14", surface: "#12121e", text: "#e0e0f0", muted: "#8888aa",
    accent: "#6c5ce7", accentAlt: "#a29bfe", border: "#2a2a3e", code: "#0d0d1a",
  },
  // User-facing: clean professional light
  light: {
    bg: "#ffffff", surface: "#f8fafc", text: "#1e293b", muted: "#64748b",
    accent: "#3b82f6", accentAlt: "#8b5cf6", border: "#e2e8f0", code: "#f1f5f9",
  },
  // User-facing: modern dark (slate tones, distinct from ubik)
  dark: {
    bg: "#0f172a", surface: "#1e293b", text: "#e2e8f0", muted: "#94a3b8",
    accent: "#38bdf8", accentAlt: "#a78bfa", border: "#334155", code: "#1e293b",
  },
  // User-facing: formal corporate — neutral base, adapts via accentColor + logo
  corporate: {
    bg: "#f8f9fa", surface: "#ffffff", text: "#2d3436", muted: "#636e72",
    accent: "#2d3436", accentAlt: "#636e72", border: "#dfe6e9", code: "#f1f3f5",
  },
  // Deprecated: alias for ubik (kept for backward compatibility)
  cyberpunk: {
    bg: "#0c0c14", surface: "#12121e", text: "#e0e0f0", muted: "#8888aa",
    accent: "#6c5ce7", accentAlt: "#a29bfe", border: "#2a2a3e", code: "#0d0d1a",
  },
};

// ─── Auto-detect needed libs from sections ───

function detectLibs(sections: ArtifactSection[]): Set<ArtifactLib> {
  const libs = new Set<ArtifactLib>(["tailwind"]);
  for (const s of sections) {
    switch (s.type) {
      case "chart":      libs.add("echarts"); break;
      case "mermaid":     libs.add("mermaid"); break;
      case "code":        libs.add("highlightjs"); break;
      case "tabs":
      case "accordion":
      case "calculator":  libs.add("alpine"); break;
      case "kanban":      libs.add("sortable"); libs.add("alpine"); break;
      case "form":        libs.add("alpine"); break;
    }
  }
  return libs;
}

// ─── Section renderers ───

function renderHero(s: ArtifactSection, t: typeof THEMES.dark): string {
  const bgStyle = s.background ? `background-image: url('${s.background}'); background-size: cover; background-position: center;` : "";
  return `<section class="relative py-20 px-8 text-center" style="${bgStyle}">
  ${s.background ? '<div class="absolute inset-0 bg-black/50"></div>' : ""}
  <div class="relative z-10 max-w-3xl mx-auto">
    <h1 class="text-5xl font-bold mb-4" style="color: ${t.accent}">${esc(s.title || "")}</h1>
    ${s.subtitle ? `<p class="text-xl" style="color: ${t.muted}">${esc(s.subtitle)}</p>` : ""}
  </div>
</section>`;
}

function renderKpi(s: ArtifactSection, t: typeof THEMES.dark): string {
  const items = (s.items || []) as KpiItem[];
  const cards = items.map(k => {
    const trendHtml = k.trend
      ? `<span class="text-sm ${k.trend.startsWith("+") || k.trend.startsWith("↑") ? "text-emerald-400" : k.trend.startsWith("-") || k.trend.startsWith("↓") ? "text-red-400" : ""}">${esc(k.trend)}</span>`
      : "";
    return `<div class="rounded-xl p-6 text-center" style="background: ${t.surface}; border: 1px solid ${t.border}">
      ${k.icon ? `<div class="text-3xl mb-2">${k.icon}</div>` : ""}
      <div class="text-3xl font-bold mb-1" style="color: ${k.color || t.accent}">${esc(String(k.value))}</div>
      <div class="text-sm" style="color: ${t.muted}">${esc(k.label)}</div>
      ${trendHtml}
    </div>`;
  });
  return `<section class="grid grid-cols-2 md:grid-cols-${Math.min(items.length, 4)} gap-4 p-6">${cards.join("\n")}</section>`;
}

function renderChart(s: ArtifactSection, t: typeof THEMES.dark, idx: number): string {
  const chartId = `chart-${idx}`;
  const chartData = typeof s.data === "string" ? s.data : JSON.stringify(s.data || {});
  return `<section class="p-6">
  ${s.title ? `<h3 class="text-lg font-semibold mb-4" style="color: ${t.text}">${esc(s.title)}</h3>` : ""}
  <div id="${chartId}" style="width: 100%; height: 400px;"></div>
  <script>
    (function() {
      var el = document.getElementById('${chartId}');
      var chart = echarts.init(el, '${t.bg === "#ffffff" ? "light" : "dark"}');
      var raw = ${chartData};
      // If raw has labels/datasets, build ECharts option
      if (raw.labels && (raw.datasets || raw.values)) {
        var labels = raw.labels;
        var datasets = raw.datasets || [{ label: 'Data', data: raw.values }];
        var type = ${JSON.stringify(s.chartType || "bar")};
        var colors = ['#00f0ff','#ff2d78','#a855f7','#22d3ee','#f59e0b','#10b981','#f43f5e','#6366f1'];
        var opt = {};
        var itemTooltip = { trigger: 'item', backgroundColor: 'rgba(15,15,25,0.9)', borderColor: '#00f0ff44', textStyle: { color: '#e0e0e0' } };
        var axisTooltip = { trigger: 'axis', backgroundColor: 'rgba(15,15,25,0.9)', borderColor: '#00f0ff44', textStyle: { color: '#e0e0e0' } };
        if (type === 'pie' || type === 'doughnut') {
          opt = { tooltip: itemTooltip, color: colors, series: [{ type: 'pie', radius: type === 'doughnut' ? ['40%','70%'] : '70%', data: labels.map(function(l,i) { return { name: l, value: datasets[0].data[i] }; }), label: { color: '#c0c0d0' }, itemStyle: { borderColor: '#0a0a14', borderWidth: 2 } }] };
        } else if (type === 'line') {
          opt = { tooltip: axisTooltip, color: colors, xAxis: { type: 'category', data: labels, axisLabel: { color: '#a0a0b0' } }, yAxis: { type: 'value', splitLine: { lineStyle: { color: '#1a1a2e' } }, axisLabel: { color: '#a0a0b0' } }, series: datasets.map(function(ds) { return { name: ds.label, type: 'line', smooth: true, data: ds.data, areaStyle: { opacity: 0.08 }, symbolSize: 6 }; }) };
        } else if (type === 'radar') {
          var max = Math.max.apply(null, datasets.reduce(function(a, ds) { return a.concat(ds.data); }, [])) || 1;
          opt = { tooltip: itemTooltip, color: colors, radar: { indicator: labels.map(function(name) { return { name: name, max: Math.ceil(max * 1.2) }; }), shape: 'polygon', axisName: { color: '#a0a0b0' }, splitArea: { areaStyle: { color: ['rgba(0,240,255,0.02)', 'rgba(0,240,255,0.05)'] } }, splitLine: { lineStyle: { color: '#1a1a2e' } } }, series: [{ type: 'radar', data: datasets.map(function(ds) { return { name: ds.label, value: ds.data, areaStyle: { opacity: 0.15 }, lineStyle: { width: 2 } }; }) }] };
        } else if (type === 'polarArea') {
          opt = { tooltip: itemTooltip, color: colors, angleAxis: { type: 'category', data: labels, axisLabel: { color: '#a0a0b0' } }, radiusAxis: { splitLine: { lineStyle: { color: '#1a1a2e' } }, axisLabel: { color: '#a0a0b0' } }, polar: {}, series: [{ type: 'bar', coordinateSystem: 'polar', data: datasets[0].data, itemStyle: { borderColor: '#0a0a14', borderWidth: 1 } }] };
        } else if (type === 'heatmap') {
          var heatData = raw.data || [];
          var yLabels = raw.yLabels || [];
          opt = { tooltip: itemTooltip, xAxis: { type: 'category', data: labels, axisLabel: { color: '#a0a0b0' } }, yAxis: { type: 'category', data: yLabels, axisLabel: { color: '#a0a0b0' } }, visualMap: { min: 0, max: Math.max.apply(null, heatData.map(function(d) { return d[2] || 0; }).concat([1])), inRange: { color: ['#0a0a14', '#00f0ff', '#ff2d78'] }, textStyle: { color: '#a0a0b0' }, orient: 'horizontal', left: 'center', bottom: 0 }, series: [{ type: 'heatmap', data: heatData, label: { show: true, color: '#e0e0e0', fontSize: 10 }, itemStyle: { borderColor: '#0a0a14', borderWidth: 2, borderRadius: 3 } }] };
        } else if (type === 'treemap') {
          var treeData = raw.data || labels.map(function(name, i) { return { name: name, value: datasets[0].data[i] || 0 }; });
          opt = { tooltip: itemTooltip, color: colors, series: [{ type: 'treemap', data: treeData, label: { color: '#e0e0e0', fontSize: 12 }, itemStyle: { borderColor: '#0a0a14', borderWidth: 2, gapWidth: 2 } }] };
        } else if (type === 'sankey') {
          opt = { tooltip: itemTooltip, series: [{ type: 'sankey', data: raw.nodes || [], links: raw.links || [], label: { color: '#e0e0e0' }, lineStyle: { color: 'gradient', curveness: 0.5, opacity: 0.3 }, itemStyle: { borderWidth: 0 }, emphasis: { lineStyle: { opacity: 0.6 } } }] };
        } else if (type === 'barH' || type === 'horizontal') {
          opt = { tooltip: axisTooltip, color: colors, yAxis: { type: 'category', data: labels, axisLabel: { color: '#a0a0b0' } }, xAxis: { type: 'value', splitLine: { lineStyle: { color: '#1a1a2e' } }, axisLabel: { color: '#a0a0b0' } }, series: datasets.map(function(ds) { return { name: ds.label, type: 'bar', data: ds.data, barMaxWidth: 40, itemStyle: { borderRadius: [0, 4, 4, 0] } }; }) };
        } else {
          opt = { tooltip: axisTooltip, color: colors, xAxis: { type: 'category', data: labels, axisLabel: { color: '#a0a0b0' } }, yAxis: { type: 'value', splitLine: { lineStyle: { color: '#1a1a2e' } }, axisLabel: { color: '#a0a0b0' } }, series: datasets.map(function(ds) { return { name: ds.label, type: 'bar', data: ds.data, barMaxWidth: 40, itemStyle: { borderRadius: [4, 4, 0, 0] } }; }) };
        }
        chart.setOption(opt);
      } else {
        chart.setOption(raw);
      }
      window.addEventListener('resize', function() { chart.resize(); });
    })();
  </script>
</section>`;
}

function renderTable(s: ArtifactSection, t: typeof THEMES.dark, idx: number): string {
  const headers = s.headers || [];
  const rows = s.rows || [];
  const tableId = `table-${idx}`;
  const searchHtml = s.searchable
    ? `<input type="text" placeholder="Rechercher..." oninput="filterTable('${tableId}', this.value)"
        class="mb-3 px-3 py-2 rounded-lg text-sm w-full max-w-xs" style="background: ${t.surface}; border: 1px solid ${t.border}; color: ${t.text}" />`
    : "";
  const sortAttr = s.sortable ? ` onclick="sortTable('${tableId}', this.cellIndex)"` : "";
  const sortClass = s.sortable ? " cursor-pointer hover:opacity-80" : "";
  const ths = headers.map(h => `<th class="px-4 py-3 text-left text-sm font-semibold${sortClass}" style="background: ${t.surface}; color: ${t.muted}; border-bottom: 2px solid ${t.border}"${sortAttr}>${esc(String(h))}</th>`).join("");
  const trs = rows.map(r =>
    `<tr class="hover:opacity-90" style="border-bottom: 1px solid ${t.border}">${r.map(c => `<td class="px-4 py-3 text-sm" style="color: ${t.text}">${esc(String(c))}</td>`).join("")}</tr>`
  ).join("\n");
  return `<section class="p-6">
  ${s.title ? `<h3 class="text-lg font-semibold mb-3" style="color: ${t.text}">${esc(s.title)}</h3>` : ""}
  ${s.caption ? `<p class="text-sm mb-3" style="color: ${t.muted}">${esc(s.caption)}</p>` : ""}
  ${searchHtml}
  <div class="overflow-x-auto rounded-xl" style="border: 1px solid ${t.border}">
    <table id="${tableId}" class="w-full"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>
  </div>
</section>`;
}

function renderMermaid(s: ArtifactSection, _t: typeof THEMES.dark, idx: number): string {
  return `<section class="p-6 flex justify-center">
  <pre class="mermaid" id="mermaid-${idx}">${esc(s.code || "graph TD\n  A-->B")}</pre>
</section>`;
}

function renderCode(s: ArtifactSection, t: typeof THEMES.dark): string {
  const lang = s.language || "";
  return `<section class="p-6">
  ${s.title ? `<h3 class="text-lg font-semibold mb-3" style="color: ${t.text}">${esc(s.title)}</h3>` : ""}
  <pre class="rounded-xl p-4 overflow-x-auto" style="background: ${t.code}; border: 1px solid ${t.border}"><code class="language-${lang}">${esc(s.content || "")}</code></pre>
</section>`;
}

function renderTabs(s: ArtifactSection, t: typeof THEMES.dark, idx: number): string {
  const tabs = (s.items || []) as TabItem[];
  const tabsJson = JSON.stringify(tabs.map(t => t.label));
  return `<section class="p-6" x-data="{ activeTab: 0 }">
  ${s.title ? `<h3 class="text-lg font-semibold mb-3" style="color: ${t.text}">${esc(s.title)}</h3>` : ""}
  <div class="flex gap-1 mb-4 rounded-lg p-1" style="background: ${t.surface}">
    ${tabs.map((tab, i) => `<button @click="activeTab = ${i}" :class="activeTab === ${i} ? 'shadow-sm' : 'opacity-60'" class="px-4 py-2 rounded-md text-sm font-medium transition-all" :style="activeTab === ${i} ? 'background: ${t.bg}; color: ${t.accent}' : 'color: ${t.muted}'">${esc(tab.label)}</button>`).join("\n    ")}
  </div>
  ${tabs.map((tab, i) => `<div x-show="activeTab === ${i}" class="transition-opacity">${tab.content}</div>`).join("\n  ")}
</section>`;
}

function renderAccordion(s: ArtifactSection, t: typeof THEMES.dark): string {
  const items = (s.items || []) as AccordionItem[];
  return `<section class="p-6 space-y-2" x-data="{ open: null }">
  ${s.title ? `<h3 class="text-lg font-semibold mb-3" style="color: ${t.text}">${esc(s.title)}</h3>` : ""}
  ${items.map((item, i) => `<div class="rounded-xl overflow-hidden" style="border: 1px solid ${t.border}">
    <button @click="open = open === ${i} ? null : ${i}" class="w-full px-5 py-4 text-left flex justify-between items-center" style="background: ${t.surface}; color: ${t.text}">
      <span class="font-medium">${esc(item.title)}</span>
      <svg :class="open === ${i} ? 'rotate-180' : ''" class="w-4 h-4 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
    </button>
    <div x-show="open === ${i}" x-collapse class="px-5 py-4" style="color: ${t.muted}">${item.content}</div>
  </div>`).join("\n  ")}
</section>`;
}

function renderText(s: ArtifactSection, t: typeof THEMES.dark): string {
  return `<section class="p-6 max-w-3xl mx-auto">
  ${s.title ? `<h2 class="text-2xl font-bold mb-4" style="color: ${t.text}">${esc(s.title)}</h2>` : ""}
  <div class="prose leading-relaxed" style="color: ${t.text}">${s.content || ""}</div>
</section>`;
}

function renderImage(s: ArtifactSection, t: typeof THEMES.dark): string {
  return `<section class="p-6 text-center">
  ${s.title ? `<h3 class="text-lg font-semibold mb-3" style="color: ${t.text}">${esc(s.title)}</h3>` : ""}
  <img src="${esc(s.src || "")}" alt="${esc(s.alt || s.title || "")}" class="max-w-full rounded-xl mx-auto" style="border: 1px solid ${t.border}" />
</section>`;
}

function renderForm(s: ArtifactSection, t: typeof THEMES.dark, idx: number): string {
  const fields = (s.items || []) as FormField[];
  return `<section class="p-6 max-w-lg mx-auto" x-data="{ submitted: false }">
  ${s.title ? `<h3 class="text-lg font-semibold mb-4" style="color: ${t.text}">${esc(s.title)}</h3>` : ""}
  <form @submit.prevent="submitted = true" class="space-y-4" x-show="!submitted">
    ${fields.map(f => {
      const base = `class="w-full px-3 py-2 rounded-lg text-sm" style="background: ${t.surface}; border: 1px solid ${t.border}; color: ${t.text}"`;
      let input: string;
      if (f.type === "textarea") {
        input = `<textarea name="${esc(f.name)}" ${base} rows="3" placeholder="${esc(f.placeholder || "")}" ${f.required ? "required" : ""}></textarea>`;
      } else if (f.type === "select") {
        input = `<select name="${esc(f.name)}" ${base} ${f.required ? "required" : ""}>${(f.options || []).map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join("")}</select>`;
      } else if (f.type === "checkbox") {
        input = `<label class="flex items-center gap-2" style="color: ${t.text}"><input type="checkbox" name="${esc(f.name)}" class="rounded" ${f.required ? "required" : ""} />${esc(f.label)}</label>`;
      } else {
        input = `<input type="${f.type}" name="${esc(f.name)}" ${base} placeholder="${esc(f.placeholder || "")}" ${f.required ? "required" : ""} />`;
      }
      return f.type === "checkbox" ? input : `<div><label class="block text-sm font-medium mb-1" style="color: ${t.muted}">${esc(f.label)}</label>${input}</div>`;
    }).join("\n    ")}
    <button type="submit" class="px-6 py-2 rounded-lg font-medium text-white" style="background: ${t.accent}">${esc(s.submitLabel || "Envoyer")}</button>
  </form>
  <div x-show="submitted" class="text-center py-8">
    <div class="text-4xl mb-2">✓</div>
    <p class="text-lg font-medium" style="color: ${t.accent}">Formulaire envoyé !</p>
  </div>
</section>`;
}

function renderTimeline(s: ArtifactSection, t: typeof THEMES.dark): string {
  const items = (s.items || []) as TimelineItem[];
  return `<section class="p-6">
  ${s.title ? `<h3 class="text-lg font-semibold mb-6" style="color: ${t.text}">${esc(s.title)}</h3>` : ""}
  <div class="relative">
    <div class="absolute left-4 top-0 bottom-0 w-0.5" style="background: ${t.border}"></div>
    ${items.map(item => `<div class="relative pl-12 pb-8">
      <div class="absolute left-2 w-5 h-5 rounded-full flex items-center justify-center text-xs" style="background: ${item.color || t.accent}; color: ${t.bg}; top: 2px">${item.icon || "●"}</div>
      <div class="rounded-xl p-4" style="background: ${t.surface}; border: 1px solid ${t.border}">
        <div class="text-xs font-mono mb-1" style="color: ${t.accent}">${esc(item.date)}</div>
        <div class="font-semibold" style="color: ${t.text}">${esc(item.title)}</div>
        ${item.description ? `<p class="text-sm mt-1" style="color: ${t.muted}">${esc(item.description)}</p>` : ""}
      </div>
    </div>`).join("\n    ")}
  </div>
</section>`;
}

function renderKanban(s: ArtifactSection, t: typeof THEMES.dark, idx: number): string {
  const columns = (s.items || []) as KanbanColumn[];
  return `<section class="p-6" x-data>
  ${s.title ? `<h3 class="text-lg font-semibold mb-4" style="color: ${t.text}">${esc(s.title)}</h3>` : ""}
  <div class="flex gap-4 overflow-x-auto pb-4">
    ${columns.map((col, ci) => `<div class="min-w-[280px] flex-shrink-0 rounded-xl p-4" style="background: ${t.surface}; border: 1px solid ${t.border}">
      <div class="flex items-center gap-2 mb-3">
        <div class="w-2 h-2 rounded-full" style="background: ${col.color || t.accent}"></div>
        <span class="font-semibold text-sm" style="color: ${t.text}">${esc(col.title)}</span>
        <span class="text-xs px-2 py-0.5 rounded-full" style="background: ${t.border}; color: ${t.muted}">${col.cards.length}</span>
      </div>
      <div id="kanban-col-${idx}-${ci}" class="space-y-2 min-h-[100px]">
        ${col.cards.map(card => `<div class="rounded-lg p-3 cursor-move" style="background: ${t.bg}; border: 1px solid ${t.border}">
          <div class="font-medium text-sm" style="color: ${t.text}">${esc(card.title)}</div>
          ${card.description ? `<p class="text-xs mt-1" style="color: ${t.muted}">${esc(card.description)}</p>` : ""}
          ${card.tag ? `<span class="inline-block text-xs px-2 py-0.5 rounded mt-2" style="background: ${t.accent}22; color: ${t.accent}">${esc(card.tag)}</span>` : ""}
        </div>`).join("\n        ")}
      </div>
    </div>`).join("\n    ")}
  </div>
  <script>
    document.addEventListener('DOMContentLoaded', function() {
      if (typeof Sortable !== 'undefined') {
        document.querySelectorAll('[id^="kanban-col-${idx}"]').forEach(function(el) {
          new Sortable(el, { group: 'kanban-${idx}', animation: 150, ghostClass: 'opacity-30' });
        });
      }
    });
  </script>
</section>`;
}

function renderComparison(s: ArtifactSection, t: typeof THEMES.dark): string {
  const items = (s.items || []) as ComparisonItem[];
  if (items.length === 0) return "";
  const featureSet = new Set<string>();
  items.forEach(i => Object.keys(i.features).forEach(k => featureSet.add(k)));
  const allFeatures: string[] = [];
  featureSet.forEach(f => allFeatures.push(f));
  return `<section class="p-6">
  ${s.title ? `<h3 class="text-lg font-semibold mb-4" style="color: ${t.text}">${esc(s.title)}</h3>` : ""}
  <div class="overflow-x-auto rounded-xl" style="border: 1px solid ${t.border}">
    <table class="w-full">
      <thead><tr>
        <th class="px-4 py-3 text-left text-sm" style="background: ${t.surface}; color: ${t.muted}; border-bottom: 2px solid ${t.border}">Fonctionnalité</th>
        ${items.map(i => `<th class="px-4 py-3 text-center text-sm font-semibold" style="background: ${i.highlight ? t.accent + "15" : t.surface}; color: ${i.highlight ? t.accent : t.text}; border-bottom: 2px solid ${t.border}">${esc(i.name)}</th>`).join("")}
      </tr></thead>
      <tbody>${allFeatures.map(f => `<tr style="border-bottom: 1px solid ${t.border}">
        <td class="px-4 py-3 text-sm font-medium" style="color: ${t.text}">${esc(f)}</td>
        ${items.map(i => {
          const v = i.features[f];
          const display = v === true ? "✓" : v === false ? "✗" : String(v ?? "—");
          const color = v === true ? "#10b981" : v === false ? "#ef4444" : t.text;
          return `<td class="px-4 py-3 text-center text-sm" style="color: ${color}">${esc(display)}</td>`;
        }).join("")}
      </tr>`).join("\n      ")}</tbody>
    </table>
  </div>
</section>`;
}

function renderCalculator(s: ArtifactSection, t: typeof THEMES.dark, idx: number): string {
  const fields = s.fields || [];
  const formula = s.formula || "0";
  const initData = fields.map(f => `${f.name}: ${f.default ?? 0}`).join(", ");
  return `<section class="p-6 max-w-md mx-auto" x-data="{ ${initData}, get result() { try { return ${formula}; } catch(e) { return 0; } } }">
  ${s.title ? `<h3 class="text-lg font-semibold mb-4" style="color: ${t.text}">${esc(s.title)}</h3>` : ""}
  <div class="space-y-4 rounded-xl p-6" style="background: ${t.surface}; border: 1px solid ${t.border}">
    ${fields.map(f => `<div>
      <label class="block text-sm font-medium mb-1" style="color: ${t.muted}">${esc(f.label)}</label>
      <input type="number" x-model.number="${f.name}" min="${f.min ?? ""}" max="${f.max ?? ""}" step="${f.step ?? 1}"
        class="w-full px-3 py-2 rounded-lg text-sm" style="background: ${t.bg}; border: 1px solid ${t.border}; color: ${t.text}" />
    </div>`).join("\n    ")}
    <div class="pt-4" style="border-top: 1px solid ${t.border}">
      <div class="text-sm" style="color: ${t.muted}">${esc(s.resultLabel || "Résultat")}</div>
      <div class="text-3xl font-bold" style="color: ${t.accent}" x-text="typeof result === 'number' ? result.toLocaleString('fr-FR', {maximumFractionDigits: 2}) : result"></div>
    </div>
  </div>
</section>`;
}

function renderSlide(s: ArtifactSection, t: typeof THEMES.dark): string {
  const layout = s.layout || "center";
  if (layout === "split" && s.image) {
    return `<div class="slide flex items-center min-h-screen">
      <div class="w-1/2 p-16">
        <h2 class="text-4xl font-bold mb-4" style="color: ${t.text}">${esc(s.title || "")}</h2>
        ${s.subtitle ? `<p class="text-xl mb-6" style="color: ${t.muted}">${esc(s.subtitle)}</p>` : ""}
        ${s.content ? `<div style="color: ${t.text}">${s.content}</div>` : ""}
      </div>
      <div class="w-1/2 p-8"><img src="${esc(s.image)}" class="rounded-xl max-h-[70vh] mx-auto" /></div>
    </div>`;
  }
  return `<div class="slide flex flex-col items-center justify-center min-h-screen p-16 text-${layout === "left" ? "left" : "center"}">
    <h2 class="text-5xl font-bold mb-6" style="color: ${t.text}">${esc(s.title || "")}</h2>
    ${s.subtitle ? `<p class="text-2xl mb-8" style="color: ${t.muted}">${esc(s.subtitle)}</p>` : ""}
    ${s.content ? `<div class="text-lg max-w-2xl" style="color: ${t.text}">${s.content}</div>` : ""}
    ${s.image ? `<img src="${esc(s.image)}" class="mt-8 rounded-xl max-h-[50vh]" />` : ""}
  </div>`;
}

// ─── Utility ───

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Table helper scripts ───

function tableScripts(): string {
  return `
  function filterTable(id, query) {
    var table = document.getElementById(id);
    if (!table) return;
    var rows = table.querySelectorAll('tbody tr');
    var q = query.toLowerCase();
    rows.forEach(function(row) {
      row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  }
  function sortTable(id, colIdx) {
    var table = document.getElementById(id);
    if (!table) return;
    var tbody = table.querySelector('tbody');
    var rows = Array.from(tbody.querySelectorAll('tr'));
    var asc = table.dataset.sortCol == colIdx && table.dataset.sortDir !== 'asc';
    table.dataset.sortCol = colIdx;
    table.dataset.sortDir = asc ? 'asc' : 'desc';
    rows.sort(function(a, b) {
      var av = a.cells[colIdx]?.textContent?.trim() || '';
      var bv = b.cells[colIdx]?.textContent?.trim() || '';
      var an = parseFloat(av), bn = parseFloat(bv);
      if (!isNaN(an) && !isNaN(bn)) return asc ? an - bn : bn - an;
      return asc ? av.localeCompare(bv) : bv.localeCompare(av);
    });
    rows.forEach(function(r) { tbody.appendChild(r); });
  }`;
}

// ─── Presentation wrapper ───

function wrapPresentation(slides: string, t: typeof THEMES.dark, title: string): string {
  return `
  <div id="presentation" x-data="{ current: 0, total: ${slides.split('class="slide').length - 1} }">
    <div class="slides-container" style="overflow: hidden">
      ${slides}
    </div>
    <div class="fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-4 px-4 py-2 rounded-full" style="background: ${t.surface}cc; backdrop-filter: blur(8px); border: 1px solid ${t.border}">
      <button @click="current = Math.max(0, current - 1)" class="px-3 py-1 rounded" style="color: ${t.text}">←</button>
      <span class="text-sm font-mono" style="color: ${t.muted}" x-text="(current + 1) + ' / ' + total"></span>
      <button @click="current = Math.min(total - 1, current + 1)" class="px-3 py-1 rounded" style="color: ${t.text}">→</button>
    </div>
  </div>
  <script>
    document.addEventListener('DOMContentLoaded', function() {
      var slides = document.querySelectorAll('.slide');
      var app = document.getElementById('presentation');
      function showSlide(n) { slides.forEach(function(s, i) { s.style.display = i === n ? '' : 'none'; }); }
      showSlide(0);
      document.addEventListener('keydown', function(e) {
        var data = Alpine.$data(app);
        if (e.key === 'ArrowRight' || e.key === ' ') { data.current = Math.min(data.total - 1, data.current + 1); showSlide(data.current); }
        if (e.key === 'ArrowLeft') { data.current = Math.max(0, data.current - 1); showSlide(data.current); }
      });
      app && Alpine.effect(function() { showSlide(Alpine.$data(app).current); });
    });
  </script>`;
}

// ─── Main builder ───

/**
 * Render a single section with default ubik theme.
 * Used by patch_html_artifact to replace one section without rebuilding everything.
 */
export function renderSection(section: ArtifactSection, index: number, theme: ArtifactTheme = "ubik"): string {
  const t = THEMES[theme];
  switch (section.type) {
    case "hero":        return renderHero(section, t);
    case "kpi":         return renderKpi(section, t);
    case "chart":       return renderChart(section, t, index);
    case "table":       return renderTable(section, t, index);
    case "mermaid":     return renderMermaid(section, t, index);
    case "code":        return renderCode(section, t);
    case "tabs":        return renderTabs(section, t, index);
    case "accordion":   return renderAccordion(section, t);
    case "text":
    case "html":        return renderText(section, t);
    case "image":       return renderImage(section, t);
    case "form":        return renderForm(section, t, index);
    case "timeline":    return renderTimeline(section, t);
    case "kanban":      return renderKanban(section, t, index);
    case "comparison":  return renderComparison(section, t);
    case "calculator":  return renderCalculator(section, t, index);
    case "slide":       return renderSlide(section, t);
    default:            return `<section class="p-6"><div style="color: ${t.muted}">Section type inconnu: ${section.type}</div></section>`;
  }
}

export async function buildHtmlArtifact(
  input: ArtifactInput,
  outputPath: string,
): Promise<BuildResult> {
  try {
    // Resolve theme (cyberpunk → ubik alias)
    const rawTheme = input.theme || "ubik";
    const theme: ArtifactTheme = rawTheme === "cyberpunk" ? "ubik" : rawTheme;
    const t = { ...THEMES[theme] };

    // Override accent color if provided (e.g. corporate theme adapting to logo)
    if (input.accentColor) {
      t.accent = input.accentColor;
      // Derive a lighter variant: blend with white at 40%
      const hex = input.accentColor.replace("#", "");
      const r = Math.min(255, Math.round(parseInt(hex.slice(0, 2), 16) * 0.6 + 255 * 0.4));
      const g = Math.min(255, Math.round(parseInt(hex.slice(2, 4), 16) * 0.6 + 255 * 0.4));
      const b = Math.min(255, Math.round(parseInt(hex.slice(4, 6), 16) * 0.6 + 255 * 0.4));
      t.accentAlt = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    }

    const sections = input.sections || [];
    const title = input.title || "UBIK Artifact";
    const logoUrl = input.logoUrl;

    // Detect + merge libs
    const detectedLibs = detectLibs(sections);
    if (input.libs) input.libs.forEach(l => detectedLibs.add(l));
    const libs: ArtifactLib[] = [];
    detectedLibs.forEach(l => libs.push(l));

    // Is this a presentation?
    const isPresentation = input.template === "presentation" || sections.every(s => s.type === "slide");
    if (isPresentation && !libs.includes("alpine")) libs.push("alpine");

    // Build <head> resources
    const cssLinks = libs.flatMap(l => CDN[l]?.css ? [`<link rel="stylesheet" href="${CDN[l].css}" />`] : []).join("\n    ");
    const jsScripts = libs.map(l => {
      if (!CDN[l]?.js) return "";
      const defer = l === "alpine" ? " defer" : "";
      return `<script src="${CDN[l].js}"${defer}><\/script>`;
    }).filter(Boolean).join("\n    ");

    // Tailwind dark mode config (dark-class for ubik and dark themes only)
    const isDarkTheme = theme === "ubik" || theme === "dark";
    const twConfig = isDarkTheme
      ? `<script>tailwind.config = { darkMode: 'class' }<\/script>`
      : "";

    // Render sections
    let sectionIdx = 0;
    const renderedSections = sections.map(s => {
      const idx = sectionIdx++;
      let sectionHtml: string;
      switch (s.type) {
        case "hero":        sectionHtml = renderHero(s, t); break;
        case "kpi":         sectionHtml = renderKpi(s, t); break;
        case "chart":       sectionHtml = renderChart(s, t, idx); break;
        case "table":       sectionHtml = renderTable(s, t, idx); break;
        case "mermaid":     sectionHtml = renderMermaid(s, t, idx); break;
        case "code":        sectionHtml = renderCode(s, t); break;
        case "tabs":        sectionHtml = renderTabs(s, t, idx); break;
        case "accordion":   sectionHtml = renderAccordion(s, t); break;
        case "text":
        case "html":        sectionHtml = renderText(s, t); break;
        case "image":       sectionHtml = renderImage(s, t); break;
        case "form":        sectionHtml = renderForm(s, t, idx); break;
        case "timeline":    sectionHtml = renderTimeline(s, t); break;
        case "kanban":      sectionHtml = renderKanban(s, t, idx); break;
        case "comparison":  sectionHtml = renderComparison(s, t); break;
        case "calculator":  sectionHtml = renderCalculator(s, t, idx); break;
        case "slide":       sectionHtml = renderSlide(s, t); break;
        default:            sectionHtml = `<section class="p-6"><div style="color: ${t.muted}">Section type inconnu: ${(s as ArtifactSection).type}</div></section>`; break;
      }
      // Wrap with section ID for patching and streaming
      return `<div id="ubik-section-${idx}">${sectionHtml}</div>`;
    });

    const body = isPresentation
      ? wrapPresentation(renderedSections.join("\n"), t, title)
      : renderedSections.join("\n");

    // Mermaid init
    const mermaidTheme = (theme === "light" || theme === "corporate") ? "default" : "dark";
    const mermaidInit = libs.includes("mermaid")
      ? `<script>document.addEventListener('DOMContentLoaded', function() { mermaid.initialize({ startOnLoad: true, theme: '${mermaidTheme}', themeVariables: { primaryColor: '${t.accent}', primaryTextColor: '${t.text}', lineColor: '${t.border}' } }); });<\/script>`
      : "";

    // Highlight.js init
    const hlInit = libs.includes("highlightjs")
      ? `<script>document.addEventListener('DOMContentLoaded', function() { hljs.highlightAll(); });<\/script>`
      : "";

    // Need table helpers?
    const needsTableHelpers = sections.some(s => s.type === "table" && (s.searchable || s.sortable));

    // Build header with optional logo
    const logoHtml = logoUrl
      ? `<img src="${esc(logoUrl)}" alt="Logo" style="height: 48px; width: auto; object-fit: contain;" />`
      : "";
    const headerHtml = !isPresentation && (title || logoUrl)
      ? `<header class="px-6 mb-8 flex items-center gap-4" style="border-bottom: 1px solid ${t.border}; padding-bottom: 16px;">
          ${logoHtml}
          ${title ? `<h1 class="text-3xl font-bold" style="color: ${t.text}">${esc(title)}</h1>` : ""}
        </header>`
      : "";

    const html = `<!DOCTYPE html>
<html lang="fr"${isDarkTheme ? ' class="dark"' : ""}>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(title)}</title>
    ${cssLinks}
    ${jsScripts}
    ${twConfig}
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: ${t.bg}; color: ${t.text}; font-family: 'Inter', 'SF Pro Display', system-ui, -apple-system, sans-serif; min-height: 100vh; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: ${t.bg}; }
        ::-webkit-scrollbar-thumb { background: ${t.border}; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: ${t.muted}; }
        ${input.styles || ""}
    </style>
</head>
<body>
  <div class="max-w-6xl mx-auto py-8">
    ${headerHtml}
    ${body}
  </div>
  ${needsTableHelpers ? `<script>${tableScripts()}<\/script>` : ""}
  ${mermaidInit}
  ${hlInit}
  ${input.scripts ? `<script>${input.scripts}<\/script>` : ""}
  <script>
  // UBIK Canvas Bridge — bidirectional iframe ↔ UBIK communication
  document.addEventListener("click", function(e) {
    var el = e.target.closest("[data-ubik-action]");
    if (el) {
      e.preventDefault();
      window.parent.postMessage({
        type: "ubik:canvas-action",
        action: el.dataset.ubikAction,
        data: JSON.parse(el.dataset.ubikData || "{}")
      }, "*");
    }
  });
  // Receive section updates from parent (streaming + patching)
  window.addEventListener("message", function(e) {
    if (e.data && e.data.type === "ubik:canvas-section") {
      var target = document.getElementById("ubik-section-" + e.data.index);
      if (target) target.outerHTML = e.data.html;
    }
  });
  <\/script>
</body>
</html>`;

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, html, "utf-8");
    const stats = await fs.stat(outputPath);

    return {
      success: true,
      output: `Artefact HTML créé: ${outputPath} (${Math.round(stats.size / 1024)} KB) — template: ${input.template || "custom"}, thème: ${theme}, libs: ${libs.join(", ")}, sections: ${sections.length}`,
      path: outputPath,
      size: stats.size,
    };
  } catch (err) {
    return {
      success: false,
      error: `Erreur création artefact: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Streaming variant of buildHtmlArtifact.
 *
 * Emits section-by-section events via a callback for
 * progressive rendering. The final result is identical to
 * the non-streaming version.
 *
 * @param onSection - callback receiving { phase, html, index, total, path }
 */
export async function buildHtmlArtifactStreaming(
  input: ArtifactInput,
  outputPath: string,
  onSection: (event: {
    phase: "shell" | "section" | "done";
    html?: string;
    index?: number;
    total?: number;
    path?: string;
  }) => void,
): Promise<BuildResult> {
  try {
    const rawTheme = input.theme || "ubik";
    const theme: ArtifactTheme = rawTheme === "cyberpunk" ? "ubik" : rawTheme;
    const t = { ...THEMES[theme] };

    if (input.accentColor) {
      t.accent = input.accentColor;
      const hex = input.accentColor.replace("#", "");
      const r = Math.min(255, Math.round(parseInt(hex.slice(0, 2), 16) * 0.6 + 255 * 0.4));
      const g = Math.min(255, Math.round(parseInt(hex.slice(2, 4), 16) * 0.6 + 255 * 0.4));
      const b = Math.min(255, Math.round(parseInt(hex.slice(4, 6), 16) * 0.6 + 255 * 0.4));
      t.accentAlt = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    }

    const sections = input.sections || [];
    const title = input.title || "UBIK Artifact";
    const logoUrl = input.logoUrl;
    const total = sections.length;

    const detectedLibs = detectLibs(sections);
    if (input.libs) input.libs.forEach(l => detectedLibs.add(l));
    const libs: ArtifactLib[] = [];
    detectedLibs.forEach(l => libs.push(l));

    const isPresentation = input.template === "presentation" || sections.every(s => s.type === "slide");
    if (isPresentation && !libs.includes("alpine")) libs.push("alpine");

    const cssLinks = libs.flatMap(l => CDN[l]?.css ? [`<link rel="stylesheet" href="${CDN[l].css}" />`] : []).join("\n    ");
    const jsScripts = libs.map(l => {
      if (!CDN[l]?.js) return "";
      const defer = l === "alpine" ? " defer" : "";
      return `<script src="${CDN[l].js}"${defer}><\/script>`;
    }).filter(Boolean).join("\n    ");

    const isDarkTheme = theme === "ubik" || theme === "dark";
    const twConfig = isDarkTheme ? `<script>tailwind.config = { darkMode: 'class' }<\/script>` : "";

    const logoHtml = logoUrl
      ? `<img src="${esc(logoUrl)}" alt="Logo" style="height: 48px; width: auto; object-fit: contain;" />`
      : "";
    const headerHtml = !isPresentation && (title || logoUrl)
      ? `<header class="px-6 mb-8 flex items-center gap-4" style="border-bottom: 1px solid ${t.border}; padding-bottom: 16px;">
          ${logoHtml}
          ${title ? `<h1 class="text-3xl font-bold" style="color: ${t.text}">${esc(title)}</h1>` : ""}
        </header>`
      : "";

    // Build section placeholders for the shell
    const placeholders = Array.from({ length: total }, (_, i) =>
      `<div id="ubik-section-${i}"><div style="padding:2rem;text-align:center;color:${t.muted};opacity:0.5">Chargement section ${i + 1}/${total}...</div></div>`
    ).join("\n    ");

    const mermaidTheme = (theme === "light" || theme === "corporate") ? "default" : "dark";
    const mermaidInit = libs.includes("mermaid")
      ? `<script>document.addEventListener('DOMContentLoaded', function() { mermaid.initialize({ startOnLoad: true, theme: '${mermaidTheme}', themeVariables: { primaryColor: '${t.accent}', primaryTextColor: '${t.text}', lineColor: '${t.border}' } }); });<\/script>`
      : "";
    const hlInit = libs.includes("highlightjs")
      ? `<script>document.addEventListener('DOMContentLoaded', function() { hljs.highlightAll(); });<\/script>`
      : "";
    const needsTableHelpers = sections.some(s => s.type === "table" && (s.searchable || s.sortable));

    // 1. Emit shell with placeholders
    const shell = `<!DOCTYPE html>
<html lang="fr"${isDarkTheme ? ' class="dark"' : ""}>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(title)}</title>
    ${cssLinks}
    ${jsScripts}
    ${twConfig}
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: ${t.bg}; color: ${t.text}; font-family: 'Inter', 'SF Pro Display', system-ui, -apple-system, sans-serif; min-height: 100vh; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: ${t.bg}; }
        ::-webkit-scrollbar-thumb { background: ${t.border}; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: ${t.muted}; }
        @keyframes ubik-pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 0.7; } }
        .ubik-section-loading { animation: ubik-pulse 1.5s ease-in-out infinite; }
        ${input.styles || ""}
    </style>
</head>
<body>
  <div class="max-w-6xl mx-auto py-8">
    ${headerHtml}
    ${placeholders}
  </div>
  ${needsTableHelpers ? `<script>${tableScripts()}<\/script>` : ""}
  ${mermaidInit}
  ${hlInit}
  ${input.scripts ? `<script>${input.scripts}<\/script>` : ""}
  <script>
  document.addEventListener("click", function(e) {
    var el = e.target.closest("[data-ubik-action]");
    if (el) { e.preventDefault(); window.parent.postMessage({ type: "ubik:canvas-action", action: el.dataset.ubikAction, data: JSON.parse(el.dataset.ubikData || "{}") }, "*"); }
  });
  window.addEventListener("message", function(e) {
    if (e.data && e.data.type === "ubik:canvas-section") {
      var target = document.getElementById("ubik-section-" + e.data.index);
      if (target) target.outerHTML = e.data.html;
    }
  });
  <\/script>
</body>
</html>`;

    onSection({ phase: "shell", html: shell });

    // 2. Render and emit sections one by one
    const renderedSections: string[] = [];
    let sectionIdx = 0;
    for (const s of sections) {
      const idx = sectionIdx++;
      let sectionHtml: string;
      switch (s.type) {
        case "hero":        sectionHtml = renderHero(s, t); break;
        case "kpi":         sectionHtml = renderKpi(s, t); break;
        case "chart":       sectionHtml = renderChart(s, t, idx); break;
        case "table":       sectionHtml = renderTable(s, t, idx); break;
        case "mermaid":     sectionHtml = renderMermaid(s, t, idx); break;
        case "code":        sectionHtml = renderCode(s, t); break;
        case "tabs":        sectionHtml = renderTabs(s, t, idx); break;
        case "accordion":   sectionHtml = renderAccordion(s, t); break;
        case "text":
        case "html":        sectionHtml = renderText(s, t); break;
        case "image":       sectionHtml = renderImage(s, t); break;
        case "form":        sectionHtml = renderForm(s, t, idx); break;
        case "timeline":    sectionHtml = renderTimeline(s, t); break;
        case "kanban":      sectionHtml = renderKanban(s, t, idx); break;
        case "comparison":  sectionHtml = renderComparison(s, t); break;
        case "calculator":  sectionHtml = renderCalculator(s, t, idx); break;
        case "slide":       sectionHtml = renderSlide(s, t); break;
        default:            sectionHtml = `<section class="p-6"><div style="color: ${t.muted}">Section type inconnu: ${s.type}</div></section>`; break;
      }

      const wrappedHtml = `<div id="ubik-section-${idx}">${sectionHtml}</div>`;
      renderedSections.push(wrappedHtml);
      onSection({ phase: "section", html: wrappedHtml, index: idx, total });
    }

    // 3. Write final complete file to disk
    const body = isPresentation
      ? wrapPresentation(renderedSections.join("\n"), t, title)
      : renderedSections.join("\n");

    // Rebuild the final HTML (same as non-streaming) with actual sections
    const finalHtml = shell.replace(placeholders, body);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, finalHtml, "utf-8");
    const stats = await fs.stat(outputPath);

    onSection({ phase: "done", path: outputPath });

    return {
      success: true,
      output: `Artefact HTML créé: ${outputPath} (${Math.round(stats.size / 1024)} KB) — template: ${input.template || "custom"}, thème: ${theme}, libs: ${libs.join(", ")}, sections: ${sections.length}`,
      path: outputPath,
      size: stats.size,
    };
  } catch (err) {
    return {
      success: false,
      error: `Erreur création artefact: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
