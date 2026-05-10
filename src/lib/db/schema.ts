/**
 * Drizzle ORM — Schema: Memoire Contextuelle Persistante (PostgreSQL)
 *
 * Systeme "Cerveau Collectif" inspire d'UBIK_ULTRA / Infinite Horizon.
 * 4 couches hierarchiques :
 *   Layer 0 — Contextes Atomiques (fonction, bloc, interface...)
 *   Layer 1 — Contextes de Tache (agregation pour un objectif)
 *   Layer 2 — Contextes de Projet (architecture, conventions)
 *   Layer 3 — Contexte Global IDE (preferences, historique, objectifs)
 *
 * + Systeme DAG complet (Directed Acyclic Graph) pour l'orchestration agent.
 */

import { pgTable, text, integer, boolean, jsonb, real, index, uniqueIndex, uuid, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// =======================================
// Layer 3 — Contexte Global IDE
// =======================================

export const globalContext = pgTable("global_context", {
  id: text("id").primaryKey(),                     // now = user_id (one row per user)
  userId: text("user_id").notNull(),               // owner
  preferences: jsonb("preferences").$type<Record<string, string>>().notNull().default({}),
  longTermGoals: jsonb("long_term_goals").$type<string[]>().notNull().default([]),
  activeProjectIds: jsonb("active_project_ids").$type<string[]>().notNull().default([]),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// =======================================
// Layer 2 — Contextes de Projet
// =======================================

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),               // owner
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  architecture: text("architecture").notNull().default(""),
  conventions: jsonb("conventions").$type<string[]>().notNull().default([]),
  dependencies: jsonb("dependencies").$type<Record<string, string>>().notNull().default({}),
  rootPath: text("root_path"),
  // GitHub Projects v2 backend (optional — null means local-only project)
  ghProjectId: text("gh_project_id"),              // GitHub Projects v2 node ID (e.g. "PVT_kwDO...")
  ghProjectNumber: integer("gh_project_number"),   // Human-readable project number
  ghOwner: text("gh_owner"),                       // GitHub user or org login
  ghOwnerType: text("gh_owner_type", { enum: ["user", "organization"] }),
  ghSyncEnabled: boolean("gh_sync_enabled").notNull().default(false),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// =======================================
// Layer 1 — Contextes de Tache
// =======================================

export const tasks = pgTable("tasks", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),               // owner
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  dagId: text("dag_id"),
  description: text("description").notNull(),
  status: text("status", { enum: ["active", "completed", "archived"] }).notNull().default("active"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// =======================================
// Layer 0 — Contextes Atomiques
// =======================================

export const atoms = pgTable("atoms", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),               // owner
  taskId: text("task_id").references(() => tasks.id, { onDelete: "cascade" }),
  type: text("type", {
    enum: ["function", "block", "interface", "intent", "observation", "variable", "snippet", "decision"],
  }).notNull(),
  source: text("source").notNull(),        // fichier ou agent d'origine
  content: text("content").notNull(),       // contenu brut
  summary: text("summary"),                 // resume condense
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// =======================================
// DAGs — Graphes d'execution agents
// =======================================

export const dags = pgTable("dags", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),               // owner
  status: text("status", { enum: ["pending", "running", "completed", "failed"] }).notNull().default("pending"),
  workspace: text("workspace"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const dagNodes = pgTable("dag_nodes", {
  id: text("id").primaryKey(),
  dagId: text("dag_id").notNull().references(() => dags.id, { onDelete: "cascade" }),
  taskDescription: text("task_description").notNull(),
  status: text("status", { enum: ["pending", "running", "completed", "failed"] }).notNull().default("pending"),
  dependencies: jsonb("dependencies").$type<string[]>().notNull().default([]),
  result: text("result"),
  logs: text("logs"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// =======================================
// SharedContext — "RAM Collective" par DAG
// =======================================

export const sharedContexts = pgTable("shared_contexts", {
  dagId: text("dag_id").primaryKey().references(() => dags.id, { onDelete: "cascade" }),
  nodeOutputs: jsonb("node_outputs").$type<Record<string, NodeOutputJSON>>().notNull().default({}),
  globals: jsonb("globals").$type<Record<string, string>>().notNull().default({}),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export interface NodeOutputJSON {
  nodeId: string;
  summary: string;
  artifacts: string[];
  filesCreated: string[];
  filesModified: string[];
  decisions: string[];
}

// =======================================
// Event Bus — Communication inter-agents
// =======================================

export const busEvents = pgTable("bus_events", {
  id: text("id").primaryKey(),
  dagId: text("dag_id").notNull().references(() => dags.id, { onDelete: "cascade" }),
  sourceNodeId: text("source_node_id").notNull(),
  targetNodeId: text("target_node_id"),
  type: text("type", {
    enum: ["REQUEST", "ACKNOWLEDGE", "CONFLICT", "REVIEW", "REJECTED", "APPROVED"],
  }).notNull(),
  payload: text("payload").notNull(),
  processed: boolean("processed").notNull().default(false),
  timestamp: text("timestamp").notNull().$defaultFn(() => new Date().toISOString()),
});

// =======================================
// Interactions — Historique Layer 3
// =======================================

export const interactions = pgTable("interactions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),               // owner
  type: text("type", { enum: ["command", "edit", "chat", "review", "debug"] }).notNull(),
  summary: text("summary").notNull(),
  contextRefs: jsonb("context_refs").$type<string[]>().notNull().default([]),
  timestamp: text("timestamp").notNull().$defaultFn(() => new Date().toISOString()),
});

// =======================================
// Memoire Vive — TTL 1h, temps reel
// =======================================

export const memoryLive = pgTable("memory_live", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),               // owner
  sessionId: text("session_id").notNull(),
  type: text("type", {
    enum: ["command", "file_op", "error", "agent_decision"],
  }).notNull(),
  source: text("source").notNull(),        // 'terminal:bash', 'claude:opus', etc.
  content: text("content").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// =======================================
// Memoire Longue — Archive permanente
// =======================================

// =======================================
// Work Items — Generic GitHub Projects v2 items
// =======================================

export const workItems = pgTable("work_items", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),

  // GitHub Projects v2 linkage
  ghItemId: text("gh_item_id"),                    // ProjectV2Item node ID
  ghContentType: text("gh_content_type", {
    enum: ["issue", "pull_request", "draft_issue"],
  }),
  ghContentId: text("gh_content_id"),              // Issue/PR/DraftIssue node ID
  ghContentNumber: integer("gh_content_number"),   // Issue/PR number (null for drafts)

  // Core fields (mirrored from GitHub or standalone)
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status", {
    enum: ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"],
  }).notNull().default("todo"),
  priority: text("priority", {
    enum: ["urgent", "high", "medium", "low", "none"],
  }).notNull().default("none"),

  // Assignment (generic — can be AI agent name, human login, or team)
  assignee: text("assignee"),
  assigneeType: text("assignee_type", { enum: ["agent", "human", "team"] }),

  // Workflow tracking (optional — only if code-related)
  branch: text("branch"),
  commitHash: text("commit_hash"),

  // Custom field values from GitHub Projects (stored as JSON for flexibility)
  ghFieldValues: jsonb("gh_field_values").$type<Record<string, any>>().notNull().default({}),

  // Sync metadata
  ghSyncedAt: text("gh_synced_at"),

  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("work_items_project_idx").on(table.projectId),
  index("work_items_user_status_idx").on(table.userId, table.status),
  index("work_items_gh_item_idx").on(table.ghItemId),
  index("work_items_assignee_idx").on(table.userId, table.assignee),
]);

// =======================================
// Git Projects — Collaboration inter-AI
// =======================================

export const gitProjects = pgTable("git_projects", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  path: text("path").notNull(),
  description: text("description").notNull().default(""),
  defaultBranch: text("default_branch").notNull().default("main"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// =======================================
// Git Tasks — Collaboration inter-AI
// =======================================

export const gitTasks = pgTable("git_tasks", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),               // owner
  projectId: text("project_id").references(() => gitProjects.id),
  projectPath: text("project_path").notNull(),
  description: text("description").notNull(),
  branch: text("branch").notNull(),
  assignee: text("assignee").notNull(),
  assigneeSessionId: text("assignee_session_id"),
  reviewer: text("reviewer"),
  reviewerSessionId: text("reviewer_session_id"),
  status: text("status", {
    enum: ["assigned", "coding", "committed", "reviewing", "approved", "rejected", "merged", "failed"],
  }).notNull().default("assigned"),
  commitHash: text("commit_hash"),
  reviewFeedback: text("review_feedback"),
  diffSummary: text("diff_summary"),
  // Skill & Agent matching (auto-populated by skill-search + agent-search)
  skillIds: text("skill_ids"),                    // Comma-separated skill IDs matched for this task
  orchestratorId: text("orchestrator_id"),        // Macro agent ID matched for orchestration
  workerIds: text("worker_ids"),                  // Comma-separated worker IDs for execution
  // Cloud Drive target
  targetProvider: text("target_provider"),      // "google" | "microsoft" | null (local only)
  targetDriveId: text("target_drive_id"),       // Drive folder/file ID
  targetType: text("target_type"),               // "file" | "folder" | null
  targetName: text("target_name"),               // Human-readable name of the target
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// =======================================
// Agent Plans — Plans d'orchestration
// =======================================

export const agentPlans = pgTable("agent_plans", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),               // owner
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status", {
    enum: ["pending", "running", "paused", "done", "error"],
  }).notNull().default("pending"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// =======================================
// Agent Phases — Phases d'un plan
// =======================================

export const agentPhases = pgTable("agent_phases", {
  id: text("id").primaryKey(),
  planId: text("plan_id").notNull().references(() => agentPlans.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  orderIndex: integer("order_index").notNull().default(0),
  status: text("status", {
    enum: ["pending", "running", "done", "error"],
  }).notNull().default("pending"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// =======================================
// Agent Tasks — Taches dans une phase
// =======================================

export const agentTasks = pgTable("agent_tasks", {
  id: text("id").primaryKey(),
  phaseId: text("phase_id").notNull().references(() => agentPhases.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  prompt: text("prompt").notNull(),
  orderIndex: integer("order_index").notNull().default(0),
  skillId: text("skill_id"),
  skillDomain: text("skill_domain"),
  skillName: text("skill_name"),
  suggestedModel: text("suggested_model"),
  model: text("model"),
  temperature: text("temperature"),
  status: text("status", {
    enum: ["pending", "approved", "running", "done", "error", "skipped"],
  }).notNull().default("pending"),
  result: text("result"),
  error: text("error"),
  createdBy: text("created_by").notNull(),
  approvedAt: text("approved_at"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// --- Connectors (OAuth tokens for third-party services) ---

export const connectors = pgTable("connectors", {
  id: text("id").primaryKey(),                     // now = "{userId}:{provider}-{service}"
  userId: text("user_id").notNull(),               // owner
  provider: text("provider").notNull(),            // "google", "microsoft"
  service: text("service").notNull(),              // "gmail", "calendar", "drive"
  enabled: boolean("enabled").notNull().default(false),
  accessTokenEnc: text("access_token_enc"),        // AES-256-GCM encrypted
  refreshTokenEnc: text("refresh_token_enc"),      // AES-256-GCM encrypted
  tokenExpiry: text("token_expiry"),               // ISO timestamp
  scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
  userEmail: text("user_email"),                   // connected account email
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// =======================================
// Routines — Automated recurring tasks
// =======================================

export const routines = pgTable("routines", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  templateId: text("template_id"),
  systemPrompt: text("system_prompt").notNull(),
  context: text("context").notNull().default(""),
  model: text("model").notNull().default("gemini-2.5-flash"),
  runtime: text("runtime").notNull().default("api"),  // "api", "cli", or "daemon"
  daemonId: text("daemon_id"),                        // daemon_id for runtime="daemon"
  intervalMs: integer("interval_ms").notNull().default(60000),
  service: text("service").notNull(),
  triggerType: text("trigger_type", { enum: ["timer", "webhook", "both"] }).notNull().default("timer"),
  webhookToken: text("webhook_token"),              // Unique token for webhook trigger URL
  webhookSecret: text("webhook_secret"),            // HMAC secret for signature validation (GitHub, Stripe, generic)
  deliverTo: text("deliver_to"),                    // Where to send results: "terminal", "whatsapp", "email"
  serverManaged: boolean("server_managed").notNull().default(false),  // True = server-side event-driven (not frontend tick)
  triggerEvent: text("trigger_event"),              // Event name that triggers this routine (e.g. "push", "payment_intent.succeeded")
  triggerConfig: text("trigger_config").default("{}"),  // JSON config for trigger (filters, conditions, etc.)
  enabled: boolean("enabled").notNull().default(false),
  lastTickAt: text("last_tick_at"),
  lastCursor: text("last_cursor"),
  lastDataHash: text("last_data_hash"),             // fingerprint of the data at last successful tick (anti-waste)
  lastError: text("last_error"),
  totalTicks: integer("total_ticks").notNull().default(0),
  totalCost: integer("total_cost").notNull().default(0),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// =======================================
// Routine Logs — Execution history
// =======================================

export const routineLogs = pgTable("routine_logs", {
  id: text("id").primaryKey(),
  routineId: text("routine_id").notNull(),
  tickNumber: integer("tick_number").notNull(),
  status: text("status").notNull(),
  inputSummary: text("input_summary"),
  llmResponse: text("llm_response"),
  actionsTaken: text("actions_taken"),
  tokensInput: integer("tokens_input").notNull().default(0),
  tokensOutput: integer("tokens_output").notNull().default(0),
  cost: integer("cost").notNull().default(0),
  durationMs: integer("duration_ms").notNull().default(0),
  error: text("error"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// =======================================
// Webhook Events — Inbound webhook audit log
// =======================================

export const webhookEvents = pgTable("webhook_events", {
  id: text("id").primaryKey(),
  routineId: text("routine_id").notNull(),
  token: text("token").notNull(),
  source: text("source"),                           // User-Agent or x-webhook-source
  event: text("event"),                             // GitHub event type, Stripe event, etc.
  status: text("status").notNull(),                 // "received", "validated", "rejected", "processing", "success", "error", "retry"
  signatureValid: boolean("signature_valid"),        // null = no signature check, true/false = checked
  httpStatus: integer("http_status"),                // Response status code sent back
  payloadSize: integer("payload_size"),              // Payload size in bytes
  payloadPreview: text("payload_preview"),           // First 500 chars of payload for debugging
  error: text("error"),
  durationMs: integer("duration_ms"),
  retryCount: integer("retry_count").notNull().default(0),
  ip: text("ip"),                                    // Client IP for rate-limit/audit
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// =======================================
// Chat Threads — Conversation persistence
// =======================================

export const chatThreads = pgTable("chat_threads", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  title: text("title").notNull().default("New thread"),
  provider: text("provider").notNull().default("google"),
  model: text("model").notNull().default("gemini-3.1-pro-preview"),
  messagesGz: text("messages_gz").notNull().default(""), // base64-encoded gzip JSON
  messageCount: integer("message_count").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// =======================================
// Watch State — UBIK's always-on awareness
// =======================================

export const watchState = pgTable("watch_state", {
  id: text("id").primaryKey(),                      // userId:service (e.g. "usr-xxx:gmail")
  userId: text("user_id").notNull(),
  service: text("service").notNull(),               // gmail, calendar, whatsapp, outlook, drive
  lastCursor: text("last_cursor"),                  // last known state (message ID, timestamp, etc.)
  lastCheckedAt: text("last_checked_at"),
  lastNotifiedAt: text("last_notified_at"),         // avoid spamming user
  enabled: boolean("enabled").notNull().default(true),
  config: jsonb("config").$type<Record<string, any>>().notNull().default({}),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const memoryArchive = pgTable("memory_archive", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),               // owner
  type: text("type", {
    enum: ["decision", "convention", "bug_fix", "architecture", "observation"],
  }).notNull(),
  source: text("source").notNull(),        // qui a archive: 'user', 'claude', 'gemini'
  title: text("title").notNull(),          // resume court
  content: text("content").notNull(),      // detail
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  // tsvector column for full-text search (populated via trigger)
  searchVector: text("search_vector"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// =======================================
// Observational Memory — Mastra-inspired
// =======================================

export const observations = pgTable("observations", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  pattern: text("pattern").notNull(),               // Compressed observation text
  context: text("context").notNull().default(""),    // Task context keywords
  toolSignature: text("tool_signature").notNull().default(""), // Sorted tool list fingerprint
  frequency: integer("frequency").notNull().default(1),
  successRate: integer("success_rate").notNull().default(1),  // stored as 0-100
  avgTokens: integer("avg_tokens").notNull().default(0),
  lastSeen: text("last_seen").notNull(),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// =======================================
// Learning Memory — Hindsight-inspired
// =======================================

export const learningMemory = pgTable("learning_memory", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  lesson: text("lesson").notNull(),                  // The learning itself
  context: text("context").notNull().default(""),    // Situation that triggered it
  outcome: text("outcome", {
    enum: ["success", "failure", "partial"],
  }).notNull().default("success"),
  source: text("source").notNull().default("agent"), // Which agent produced this
  weight: integer("weight").notNull().default(1),    // stored as 0-100 (10 = 1.0)
  recallCount: integer("recall_count").notNull().default(0),
  lastRecalled: text("last_recalled"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// =======================================
// Qubik — Pre-processor cache
// =======================================

export const qubikCache = pgTable("qubik_cache", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  level: text("level", { enum: ["L1_exact", "L2_intent", "L3_template"] }).notNull(),
  queryHash: text("query_hash").notNull(),
  query: text("query").notNull(),
  intent: text("intent"),
  entities: jsonb("entities").$type<string[]>().notNull().default([]),
  output: text("output").notNull(),               // Full QubikOutput JSON
  model: text("model").notNull().default(""),
  toolsUsed: jsonb("tools_used").$type<string[]>().notNull().default([]),
  hitCount: integer("hit_count").notNull().default(0),
  avgSavingsTokens: integer("avg_savings_tokens").notNull().default(0),
  ttlSeconds: integer("ttl_seconds").notNull().default(3600),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// =======================================
// Qubik — Feedback loop
// =======================================

export const qubikFeedback = pgTable("qubik_feedback", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  queryHash: text("query_hash").notNull(),
  intent: text("intent").notNull(),
  complexity: integer("complexity").notNull(),
  predictedModel: text("predicted_model").notNull(),
  actualModel: text("actual_model").notNull(),
  predictedTools: jsonb("predicted_tools").$type<string[]>().notNull().default([]),
  actualTools: jsonb("actual_tools").$type<string[]>().notNull().default([]),
  predictedRounds: integer("predicted_rounds").notNull().default(1),
  actualRounds: integer("actual_rounds").notNull().default(1),
  tokensInput: integer("tokens_input").notNull().default(0),
  tokensOutput: integer("tokens_output").notNull().default(0),
  tokensSaved: integer("tokens_saved").notNull().default(0),
  success: boolean("success").notNull().default(true),
  shortCircuited: boolean("short_circuited").notNull().default(false),
  durationMs: integer("duration_ms").notNull().default(0),
  qubikDurationMs: integer("qubik_duration_ms").notNull().default(0),
  // QUBIK v3 cascade tracking
  layersActivated: integer("layers_activated").notNull().default(1),
  flashConfidence: real("flash_confidence"),
  proVerdict: text("pro_verdict"),        // "approved" | "enriched" | "needs_arbitration"
  escalationReason: text("escalation_reason"),
  cascadeModels: jsonb("cascade_models").$type<string[]>().notNull().default([]),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// =======================================
// Users
// =======================================

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  avatar: text("avatar"),
  role: text("role", { enum: ["creator", "admin", "user"] }).notNull().default("user"),
  plan: text("plan").notNull().default("free"),
  walletBalance: real("wallet_balance").notNull().default(5.0),
  walletTotalSpent: real("wallet_total_spent").notNull().default(0),
  walletTotalRecharged: real("wallet_total_recharged").notNull().default(5.0),
  stripeCustomerId: text("stripe_customer_id"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  lastLoginAt: text("last_login_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// =======================================
// Wallet Transactions
// =======================================

export const walletTransactions = pgTable("wallet_transactions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  amount: real("amount").notNull(),
  description: text("description").notNull(),
  stripePaymentId: text("stripe_payment_id"),
  metadata: text("metadata"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// =======================================
// Bureaux
// =======================================

export const bureaux = pgTable("bureaux", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  containerId: text("container_id"),
  containerStatus: text("container_status").notNull().default("stopped"),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// =======================================
// Expert Patterns — Personas personnalisés
// =======================================

export interface ExpertDocumentRef {
  name: string;           // display name
  source: "drive" | "onedrive" | "upload" | "url";
  sourceId?: string;      // Drive/OneDrive file ID
  sourceUrl?: string;     // URL or local path
  mimeType?: string;
  content: string;        // extracted text content (for LLM injection)
  extractedAt: string;    // ISO 8601
}

export const expertPatterns = pgTable("expert_patterns", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  icon: text("icon").notNull().default("Briefcase"),           // lucide icon name
  color: text("color").notNull().default("text-cyan-400"),     // tailwind color class
  systemPrompt: text("system_prompt").notNull(),               // persona instructions
  documents: jsonb("documents").$type<ExpertDocumentRef[]>().notNull().default([]),
  isBuiltin: boolean("is_builtin").notNull().default(false),   // true for default experts
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("expert_patterns_user_idx").on(table.userId),
]);

// =======================================
// Expert Embeddings — RAG chunks for expert documents
// =======================================

export const expertEmbeddings = pgTable("expert_embeddings", {
  id: text("id").primaryKey(),
  patternId: text("pattern_id").notNull(),
  docName: text("doc_name").notNull(),
  chunkIndex: integer("chunk_index").notNull().default(0),
  chunkText: text("chunk_text").notNull(),
  // embedding vector(1536) is handled via raw SQL (pgvector extension)
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("expert_embeddings_pattern_idx").on(table.patternId),
]);

// =======================================
// Voice Profiles — Fine-tuning voice clones
// =======================================

export interface VoiceSampleRef {
  name: string;
  source: "drive" | "onedrive" | "local";
  sourceId?: string;
  durationSec: number;
  mimeType: string;
}

export const voiceProfiles = pgTable("voice_profiles", {
  id: text("id").primaryKey(),                         // "vp-{ts}-{rand}"
  userId: text("user_id").notNull(),
  name: text("name").notNull(),                        // "Alexandre"
  slug: text("slug").notNull(),                        // "alexandre"
  type: text("type", {
    enum: ["voice", "style"],
  }).notNull().default("voice"),
  status: text("status", {
    enum: ["pending", "processing", "ready", "failed"],
  }).notNull().default("pending"),
  chatterboxVoiceId: text("chatterbox_voice_id"),      // ID returned by Chatterbox TTS Server
  sampleSources: jsonb("sample_sources").$type<VoiceSampleRef[]>().notNull().default([]),
  sampleCount: integer("sample_count").notNull().default(0),
  totalDurationSec: integer("total_duration_sec").notNull().default(0),
  gpuJobId: text("gpu_job_id"),                        // GCloud Spot VM instance name
  gpuCostEstimate: real("gpu_cost_estimate"),
  description: text("description").notNull().default(""),
  error: text("error"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("voice_profiles_user_idx").on(table.userId),
  index("voice_profiles_slug_idx").on(table.userId, table.slug),
]);

// =======================================
// Agent Infrastructure — Sessions, Journal, State
// =======================================

export const agentSessions = pgTable("agent_sessions", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),               // "grossiste", "office-manager", etc.
  userId: text("user_id").notNull(),
  status: text("status", {
    enum: ["running", "done", "error"],
  }).notNull().default("running"),
  phaseReached: integer("phase_reached").notNull().default(0),
  summary: jsonb("summary").$type<Record<string, unknown>>().notNull().default({}),
  reportDriveId: text("report_drive_id"),             // Drive file ID of HTML report
  startedAt: text("started_at").notNull().$defaultFn(() => new Date().toISOString()),
  endedAt: text("ended_at"),
}, (table) => [
  index("agent_sessions_user_agent_idx").on(table.userId, table.agentId),
  index("agent_sessions_started_idx").on(table.userId, table.agentId, table.startedAt),
]);

export const agentJournal = pgTable("agent_journal", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => agentSessions.id, { onDelete: "cascade" }),
  agentId: text("agent_id").notNull(),
  userId: text("user_id").notNull(),
  phase: integer("phase").notNull().default(0),
  action: text("action").notNull(),                   // "commande_saisie", "email_envoyé", "client_contacté"
  targetType: text("target_type"),                    // "client", "email", "task", "file"
  targetId: text("target_id"),                        // CLI-042, CMD-2026-001
  targetLabel: text("target_label"),                  // "Boulangerie Martin"
  metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull().default({}),
  notes: text("notes"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("agent_journal_user_agent_idx").on(table.userId, table.agentId, table.createdAt),
  index("agent_journal_session_idx").on(table.sessionId),
  index("agent_journal_action_idx").on(table.userId, table.action),
]);

export const agentState = pgTable("agent_state", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  userId: text("user_id").notNull(),
  key: text("key").notNull(),                         // "preferences", "derniere_tournee", "crm_version"
  value: jsonb("value").$type<unknown>().notNull().default({}),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  uniqueIndex("agent_state_unique_idx").on(table.userId, table.agentId, table.key),
]);

// =======================================
// CRM — Catalogue Produits
// =======================================

export const crmProducts = pgTable("crm_products", {
  id: text("id").primaryKey(),                        // PRD-001
  userId: text("user_id").notNull(),
  reference: text("reference"),                       // Ref fournisseur libre
  name: text("name").notNull(),
  category: text("category"),
  unit: text("unit").notNull().default("pièce"),      // "kg", "pièce", "carton"
  conditioning: text("conditioning"),                 // "carton de 6", "palette"
  priceHt: real("price_ht").notNull().default(0),
  tvaRate: real("tva_rate").notNull().default(20),
  active: boolean("active").notNull().default(true),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("crm_products_user_idx").on(table.userId),
  index("crm_products_category_idx").on(table.userId, table.category),
]);

// =======================================
// CRM — Clients
// =======================================

export const crmClients = pgTable("crm_clients", {
  id: text("id").primaryKey(),                        // CLI-001
  userId: text("user_id").notNull(),
  code: text("code"),                                 // Code commercial libre
  name: text("name").notNull(),
  company: text("company"),
  address: text("address"),
  phone: text("phone"),                               // aussi WhatsApp
  email: text("email"),
  deliveryDay: text("delivery_day"),                  // "lundi", "mardi"...
  conditions: jsonb("conditions").$type<Record<string, unknown>>().notNull().default({}),
  notes: text("notes"),
  score: text("score"),                               // "green", "yellow", "red" — calculé
  active: boolean("active").notNull().default(true),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("crm_clients_user_idx").on(table.userId),
  index("crm_clients_delivery_idx").on(table.userId, table.deliveryDay),
  index("crm_clients_score_idx").on(table.userId, table.score),
]);

// =======================================
// CRM — Commandes (orders + lines)
// =======================================

export const crmOrders = pgTable("crm_orders", {
  id: text("id").primaryKey(),                        // CMD-2026-0001
  userId: text("user_id").notNull(),
  clientId: text("client_id").notNull().references(() => crmClients.id, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => agentSessions.id),
  orderDate: text("order_date").notNull(),
  channel: text("channel"),                           // "whatsapp", "email", "tel", "direct"
  status: text("status", {
    enum: ["draft", "confirmed", "delivered", "cancelled"],
  }).notNull().default("confirmed"),
  totalHt: real("total_ht").notNull().default(0),
  notes: text("notes"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("crm_orders_user_idx").on(table.userId),
  index("crm_orders_client_idx").on(table.userId, table.clientId),
  index("crm_orders_date_idx").on(table.userId, table.orderDate),
]);

export const crmOrderLines = pgTable("crm_order_lines", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => crmOrders.id, { onDelete: "cascade" }),
  productId: text("product_id").notNull().references(() => crmProducts.id),
  quantity: real("quantity").notNull(),
  unitPriceHt: real("unit_price_ht").notNull(),
  lineTotalHt: real("line_total_ht").notNull(),
}, (table) => [
  index("crm_order_lines_order_idx").on(table.orderId),
  index("crm_order_lines_product_idx").on(table.productId),
]);

// =======================================
// CRM — Tournées (delivery rounds)
// =======================================

export const crmRounds = pgTable("crm_rounds", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  day: text("day").notNull(),                         // "lundi", "mardi"...
  clientId: text("client_id").notNull().references(() => crmClients.id, { onDelete: "cascade" }),
  orderIndex: integer("order_index").notNull().default(0),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("crm_rounds_user_day_idx").on(table.userId, table.day),
]);

// =======================================
// CRM — Télévente (telesales tracking)
// =======================================

export const crmTelesales = pgTable("crm_telesales", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  sessionId: text("session_id").references(() => agentSessions.id),
  clientId: text("client_id").notNull().references(() => crmClients.id, { onDelete: "cascade" }),
  contactDate: text("contact_date").notNull(),
  channel: text("channel"),                           // "whatsapp", "email", "tel"
  status: text("status", {
    enum: ["contacté", "commandé", "pas_de_réponse", "relance"],
  }).notNull().default("contacté"),
  orderId: text("order_id").references(() => crmOrders.id),
  nextFollowup: text("next_followup"),                // date de relance
  notes: text("notes"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("crm_telesales_user_idx").on(table.userId, table.contactDate),
  index("crm_telesales_client_idx").on(table.userId, table.clientId),
  index("crm_telesales_followup_idx").on(table.userId, table.status, table.nextFollowup),
]);

// =======================================
// CRM — Activités (activity log)
// =======================================

export const crmActivities = pgTable("crm_activities", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  clientId: text("client_id").notNull().references(() => crmClients.id, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => agentSessions.id),
  type: text("type").notNull(),                       // "appel", "email", "whatsapp", "rdv"
  summary: text("summary").notNull(),
  followUp: text("follow_up"),                        // action à faire
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("crm_activities_user_idx").on(table.userId, table.createdAt),
  index("crm_activities_client_idx").on(table.userId, table.clientId),
]);

// =======================================
// Skills Library — 23k+ expert personas in DB
// =======================================

export const skillDomains = pgTable("skill_domains", {
  id: text("id").primaryKey(),                          // domain folder name
  name: text("name").notNull(),
  icon: text("icon").notNull().default(""),
  description: text("description").notNull().default(""),
  category: text("category").notNull().default(""),     // consolidated root category
  skillCount: integer("skill_count").notNull().default(0),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("skill_domains_category_idx").on(table.category),
]);

export const skills = pgTable("skills", {
  id: text("id").primaryKey(),                          // skill ID
  domainId: text("domain_id").notNull().references(() => skillDomains.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  icon: text("icon").notNull().default(""),
  description: text("description").notNull().default(""),
  model: text("model").notNull().default(""),           // empty — UBIK choisit à runtime
  temperature: real("temperature").notNull().default(0.4),
  tools: jsonb("tools").$type<string[]>().notNull().default([]),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  examples: jsonb("examples").$type<string[]>().notNull().default([]),
  category: text("category").notNull().default(""),     // denormalized from domain
  systemPrompt: text("system_prompt").notNull().default(""),
  polished: boolean("polished").notNull().default(false),
  qualityTier: text("quality_tier", {
    enum: ["core", "extended", "niche", "duplicate"],
  }).notNull().default("extended"),
  duplicateOf: text("duplicate_of"),                    // ID du skill dont c'est un doublon
  // tsvector column for full-text search (populated via trigger in connection.ts)
  searchVector: text("search_vector"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("skills_domain_idx").on(table.domainId),
  index("skills_category_idx").on(table.category),
  index("skills_quality_tier_idx").on(table.qualityTier),
]);

export const skillUsage = pgTable("skill_usage", {
  id: text("id").primaryKey(),
  skillId: text("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  score: integer("score").notNull().default(0),
  success: boolean("success").notNull().default(true),
  durationMs: integer("duration_ms").notNull().default(0),
  invokedAt: text("invoked_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("skill_usage_skill_idx").on(table.skillId),
  index("skill_usage_user_idx").on(table.userId),
  index("skill_usage_invoked_idx").on(table.invokedAt),
]);

// =======================================
// MCP Registry — Tools & Servers in DB
// =======================================

export const mcpServers = pgTable("mcp_servers", {
  id: text("id").primaryKey(),                           // server name: "ubik-git", "whatsapp", "__builtin"
  name: text("name").notNull(),                          // display name: "Git Collab"
  type: text("type", {
    enum: ["local", "remote", "builtin"],
  }).notNull().default("local"),
  transport: text("transport", {
    enum: ["stdio", "sse", "http"],
  }).notNull().default("stdio"),
  command: text("command"),                              // spawn command: "npx tsx src/mcp/ubik-git-server.ts"
  url: text("url"),                                      // remote URL (SSE/HTTP)
  toolCount: integer("tool_count").notNull().default(0),
  status: text("status", {
    enum: ["online", "offline", "error", "unknown"],
  }).notNull().default("unknown"),
  lastSyncAt: text("last_sync_at"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const mcpTools = pgTable("mcp_tools", {
  id: text("id").primaryKey(),                           // "ubik-google:gmail_search" (server:tool)
  serverId: text("server_id").notNull().references(() => mcpServers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),                          // "gmail_search"
  description: text("description").notNull().default(""),
  inputSchema: jsonb("input_schema").$type<Record<string, unknown>>().notNull().default({}),
  category: text("category").notNull().default(""),      // "email", "files", "search"
  // tsvector for full-text search (trigger in connection.ts)
  searchVector: text("search_vector"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("mcp_tools_server_idx").on(table.serverId),
  index("mcp_tools_name_idx").on(table.name),
  index("mcp_tools_category_idx").on(table.category),
]);

export const mcpToolUsage = pgTable("mcp_tool_usage", {
  id: text("id").primaryKey(),
  toolId: text("tool_id").notNull().references(() => mcpTools.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  success: boolean("success").notNull().default(true),
  durationMs: integer("duration_ms").notNull().default(0),
  error: text("error"),
  invokedAt: text("invoked_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("mcp_tool_usage_tool_idx").on(table.toolId),
  index("mcp_tool_usage_user_idx").on(table.userId),
  index("mcp_tool_usage_invoked_idx").on(table.invokedAt),
]);

// =======================================
// User Add-ons (marketplace extensions)
// =======================================

export const userAddons = pgTable("user_addons", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  addonId: text("addon_id").notNull(),            // "agents", "git-collab", "routines", "workflows", "finetuning"
  enabled: boolean("enabled").notNull().default(true),
  installedAt: text("installed_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  uniqueIndex("user_addons_unique_idx").on(table.userId, table.addonId),
]);

// =======================================
// WhatsApp Agent — Configuration per user
// =======================================

export const whatsappAgent = pgTable("whatsapp_agent", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  groupJid: text("group_jid"),                     // WhatsApp group JID created by UBIK
  groupName: text("group_name").notNull().default("UBIK"),
  enabled: boolean("enabled").notNull().default(true),
  systemPrompt: text("system_prompt"),             // Custom system prompt for WhatsApp interactions
  maxToolIterations: integer("max_tool_iterations").notNull().default(5),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  uniqueIndex("whatsapp_agent_user_idx").on(table.userId),
]);

export const discordAgent = pgTable("discord_agent", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  guildId: text("guild_id"),
  guildName: text("guild_name").notNull().default(""),
  channelId: text("channel_id"),
  enabled: boolean("enabled").notNull().default(true),
  systemPrompt: text("system_prompt"),
  maxToolIterations: integer("max_tool_iterations").notNull().default(5),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  uniqueIndex("discord_agent_user_idx").on(table.userId),
]);

// =======================================
// KMS — Knowledge Management System
// =======================================

export const kmsDocuments = pgTable("kms_documents", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  collection: text("collection").notNull(),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull().default("draft"),
  frontmatter: jsonb("frontmatter").$type<Record<string, unknown>>().notNull().default({}),
  content: text("content").notNull().default(""),
  filePath: text("file_path").notNull(),
  checksum: text("checksum").notNull(),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  // search_vector TSVECTOR — populated via trigger (see migration 0005)
  searchVector: text("search_vector"),
  // embedding VECTOR(768) — populated by indexer (see migration 0005)
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("kms_docs_user_collection_idx").on(table.userId, table.collection),
  uniqueIndex("kms_docs_user_slug_idx").on(table.userId, table.collection, table.slug),
  index("kms_docs_checksum_idx").on(table.checksum),
  index("kms_docs_status_idx").on(table.userId, table.status),
]);


// =======================================
// URM — Universal Relationship Management
// =======================================

export const urmNodes = pgTable('urm_nodes', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  type: text('type').notNull(), // 'human', 'project', 'organization', 'document'
  name: text('name').notNull(),
  attributes: jsonb('attributes').$type<Record<string, any>>().notNull().default({}),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index('urm_nodes_user_idx').on(table.userId),
  index('urm_nodes_type_idx').on(table.type),
]);

export const urmEdges = pgTable('urm_edges', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  sourceId: text('source_id').notNull().references(() => urmNodes.id, { onDelete: 'cascade' }),
  targetId: text('target_id').notNull().references(() => urmNodes.id, { onDelete: 'cascade' }),
  relationType: text('relation_type').notNull(),
  metadata: jsonb('metadata').$type<Record<string, any>>().notNull().default({}),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index('urm_edges_user_idx').on(table.userId),
  index('urm_edges_source_idx').on(table.sourceId),
  index('urm_edges_target_idx').on(table.targetId),
]);

export const urmObservations = pgTable('urm_observations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  nodeId: text('node_id').notNull().references(() => urmNodes.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  sourceUri: text('source_uri'),
  timestamp: text('timestamp').notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index('urm_obs_user_idx').on(table.userId),
  index('urm_obs_node_idx').on(table.nodeId),
]);

export const urmIngestionQueue = pgTable('urm_ingestion_queue', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  source: text('source').notNull(), // 'gmail', 'whatsapp', 'drive', etc.
  payload: text('payload').notNull(), // raw text or JSON string
  metadata: jsonb('metadata').$type<Record<string, any>>().notNull().default({}),
  status: text('status').notNull().default('pending'), // 'pending', 'processing', 'completed', 'failed'
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  processedAt: text('processed_at'),
}, (table) => [
  index('urm_queue_user_status_idx').on(table.userId, table.status),
]);

// ═══════════════════════════════════════════════════════════════════════════════
// JDR Module — Game tables (migrated from ubik-jdr)
// ═══════════════════════════════════════════════════════════════════════════════

export const jdrScenarios = pgTable("jdr_scenarios", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  universe: text("universe").notNull().default("Univers libre"),
  description: text("description"),
  tone: text("tone"),
  setting: text("setting"),
  stats: jsonb("stats").notNull().default([]),
  archetypes: jsonb("archetypes").notNull().default([]),
  uiConfig: jsonb("ui_config").notNull().default({}),
  initialClocks: jsonb("initial_clocks").notNull().default([]),
  initialLocations: jsonb("initial_locations").notNull().default([]),
  initialFactions: jsonb("initial_factions").notNull().default([]),
  initialQuest: jsonb("initial_quest").notNull().default({}),
  rulesNarrative: jsonb("rules_narrative").notNull().default([]),
  openingScene: jsonb("opening_scene"),
  active: boolean("active").default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const jdrCampaigns = pgTable("jdr_campaigns", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  scenarioId: uuid("scenario_id").references(() => jdrScenarios.id),
  worldBible: jsonb("world_bible"),
  settings: jsonb("settings"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const jdrFactions = pgTable("jdr_factions", {
  id: uuid("id").defaultRandom().primaryKey(),
  campaignId: uuid("campaign_id").references(() => jdrCampaigns.id).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  agenda: text("agenda"),
  power: integer("power").notNull().default(50),
  visibility: text("visibility").notNull().default("unknown"),
});

export const jdrCharacters = pgTable("jdr_characters", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(), // maps to UBIK users (not separate players table)
  campaignId: uuid("campaign_id").references(() => jdrCampaigns.id).notNull(),
  name: text("name").notNull(),
  archetype: text("archetype").notNull(),
  background: text("background"),
  stats: jsonb("stats").notNull(),
  inventory: jsonb("inventory").notNull().default([]),
  traits: jsonb("traits").notNull().default([]),
  statusEffects: jsonb("status_effects").notNull().default([]),
  corruption: integer("corruption").notNull().default(0),
  reputation: jsonb("reputation").notNull().default({}),
  status: text("status").notNull().default("alive"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const jdrSessions = pgTable("jdr_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  campaignId: uuid("campaign_id").references(() => jdrCampaigns.id).notNull(),
  characterId: uuid("character_id").references(() => jdrCharacters.id).notNull(),
  number: integer("number").notNull().default(1),
  status: text("status").notNull().default("active"),
  recap: text("recap"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  endedAt: timestamp("ended_at"),
});

export const jdrScenes = pgTable("jdr_scenes", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").references(() => jdrSessions.id).notNull(),
  locationId: uuid("location_id").references(() => jdrLocations.id),
  number: integer("number").notNull(),
  title: text("title"),
  narration: text("narration").notNull(),
  choices: jsonb("choices"),
  state: jsonb("state"),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const jdrQuests = pgTable("jdr_quests", {
  id: uuid("id").defaultRandom().primaryKey(),
  campaignId: uuid("campaign_id").references(() => jdrCampaigns.id).notNull(),
  sessionId: uuid("session_id").references(() => jdrSessions.id),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("active"),
  objectives: jsonb("objectives").notNull().default([]),
  rewards: jsonb("rewards"),
  discoveredAt: timestamp("discovered_at").defaultNow().notNull(),
});

export const jdrNpcs = pgTable("jdr_npcs", {
  id: uuid("id").defaultRandom().primaryKey(),
  campaignId: uuid("campaign_id").references(() => jdrCampaigns.id).notNull(),
  name: text("name").notNull(),
  role: text("role"),
  factionId: uuid("faction_id").references(() => jdrFactions.id),
  description: text("description"),
  personality: text("personality"),
  memory: jsonb("memory").notNull().default([]),
  alive: boolean("alive").notNull().default(true),
  disposition: integer("disposition").notNull().default(0),
});

export const jdrDangerClocks = pgTable("jdr_danger_clocks", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").references(() => jdrSessions.id).notNull(),
  locationId: uuid("location_id").references(() => jdrLocations.id),
  name: text("name").notNull(),
  description: text("description"),
  current: integer("current").notNull().default(0),
  max: integer("max").notNull().default(6),
  triggered: boolean("triggered").notNull().default(false),
});

export const jdrWorldMemories = pgTable("jdr_world_memories", {
  id: uuid("id").defaultRandom().primaryKey(),
  campaignId: uuid("campaign_id").references(() => jdrCampaigns.id).notNull(),
  sessionId: uuid("session_id").references(() => jdrSessions.id),
  type: text("type").notNull(),
  content: text("content").notNull(),
  tags: jsonb("tags").notNull().default([]),
  importance: integer("importance").notNull().default(5),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const jdrActionLogs = pgTable("jdr_action_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").references(() => jdrSessions.id).notNull(),
  locationId: uuid("location_id").references(() => jdrLocations.id),
  sceneId: uuid("scene_id").references(() => jdrScenes.id),
  actionType: text("action_type").notNull(),
  input: text("input").notNull(),
  resolution: jsonb("resolution"),
  narrativeResult: text("narrative_result"),
  stateChanges: jsonb("state_changes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const jdrLocations = pgTable("jdr_locations", {
  id: uuid("id").defaultRandom().primaryKey(),
  campaignId: uuid("campaign_id").references(() => jdrCampaigns.id).notNull(),
  name: text("name").notNull(),
  district: text("district"),
  description: text("description"),
  dangerLevel: integer("danger_level").notNull().default(0),
  discovered: boolean("discovered").notNull().default(false),
  tags: jsonb("tags").notNull().default([]),
  connections: jsonb("connections").notNull().default([]),
});
