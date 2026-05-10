/**
 * Drizzle ORM — PostgreSQL Database Connection
 *
 * Singleton connection pool to PostgreSQL.
 * Schema is defined in schema.ts (single source of truth).
 * Table creation is handled by Drizzle Kit migrations.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema";
import { dbLogger } from "../logger";

type PgPool = InstanceType<typeof pg.Pool>;

// ─── Database URL ───
const DATABASE_URL = process.env.DATABASE_URL || "postgresql://ubik:ubik_dev@localhost:5432/ubik";

// ─── Singleton PostgreSQL connection ───
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;
let pool: PgPool | null = null;

/**
 * Get the Drizzle ORM database instance (singleton).
 * Initializes the PostgreSQL connection pool on first call.
 * @returns Drizzle database instance with schema
 */
export function getDb() {
  if (!dbInstance) {
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      max: 20,
    });

    dbInstance = drizzle(pool, { schema });

    dbLogger.info({ url: DATABASE_URL.replace(/\/\/.*@/, "//***@") }, "PostgreSQL connected");
  }
  return dbInstance;
}

/**
 * Get the raw pg Pool for direct SQL queries.
 * Replaces the old getSqlite() function — callers use pool.query() instead.
 */
export function getPool(): PgPool {
  if (!pool) {
    getDb(); // Initialize the pool
  }
  return pool!;
}

/**
 * Ensure all tables, indexes, and full-text search infrastructure exist.
 *
 * Table creation is handled by Drizzle Kit migrations (schema.ts is the
 * single source of truth).  This function only sets up things Drizzle
 * cannot handle: PostgreSQL extensions, tsvector triggers, and FTS indexes.
 *
 * To create/update tables run:
 *   npx drizzle-kit push   (dev — applies schema.ts directly)
 *   npx drizzle-kit generate && npx drizzle-kit migrate  (production)
 */
export async function ensureTables() {
  const p = getPool();
  const db = getDb();

  // ─── PostgreSQL extensions ───
  await p.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
  await p.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);
  await p.query(`CREATE EXTENSION IF NOT EXISTS "vector"`);

  // ─── Apply Drizzle migrations (tables from schema.ts) ───
  // Tolerate "already exists" errors — migrations may have been applied via `drizzle-kit push`
  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
  } catch (err: any) {
    const msg = String(err?.message || "") + String(err?.cause?.message || "") + (err?.code || "");
    if (msg.includes("already exists") || msg.includes("42P07") || err?.cause?.code === "42P07") {
      console.warn(`[DB] Migration skipped (tables already exist) — use 'drizzle-kit push' for schema sync`);
    } else {
      throw err;
    }
  }

  // ─── JDR campaign linkage + universe taxonomy (safe ALTER/BACKFILL) ───
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE jdr_scenarios
        ADD COLUMN IF NOT EXISTS universe text NOT NULL DEFAULT 'Univers libre';
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);

  await p.query(`
    UPDATE jdr_scenarios
    SET universe = CASE slug
      WHEN 'archives-fantomes' THEN 'Cyberpunk'
      WHEN 'neon-chrome' THEN 'Cyberpunk'
      WHEN 'veilspire' THEN 'Dark fantasy'
      WHEN 'trone-du-dragon' THEN 'Heroic fantasy'
      WHEN 'astralys' THEN 'Space opera'
      WHEN 'exodus-prime' THEN 'Science-fiction'
      WHEN 'nexus-horizon' THEN 'Science-fiction'
      WHEN 'abysses-de-karthane' THEN 'Horreur cosmique'
      WHEN 'la-rouille' THEN 'Post-apocalyptique'
      WHEN 'ville-aux-miroirs' THEN 'Noir fantastique'
      WHEN 'aetheria' THEN 'Steampunk'
      WHEN 'monde-creux' THEN 'Aventure pulp'
      ELSE universe
    END
    WHERE universe IS NULL OR universe = '' OR universe = 'Univers libre';
  `);

  await p.query(`
    UPDATE jdr_campaigns AS campaign
    SET scenario_id = scenario.id
    FROM jdr_scenarios AS scenario
    WHERE campaign.scenario_id IS NULL
      AND (
        regexp_replace(campaign.slug, '-\\d+$', '') = scenario.slug
        OR campaign.name = scenario.name
      );
  `);

  // ─── QUBIK v3 cascade columns (safe ALTER — idempotent) ───
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE qubik_feedback ADD COLUMN IF NOT EXISTS layers_activated integer NOT NULL DEFAULT 1;
      ALTER TABLE qubik_feedback ADD COLUMN IF NOT EXISTS flash_confidence real;
      ALTER TABLE qubik_feedback ADD COLUMN IF NOT EXISTS pro_verdict text;
      ALTER TABLE qubik_feedback ADD COLUMN IF NOT EXISTS escalation_reason text;
      ALTER TABLE qubik_feedback ADD COLUMN IF NOT EXISTS cascade_models jsonb NOT NULL DEFAULT '[]'::jsonb;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);

  // ─── pgvector column on expert_embeddings (Drizzle can't handle vector type) ───
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE expert_embeddings ADD COLUMN IF NOT EXISTS embedding vector(1536);
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS expert_embeddings_vector_idx
      ON expert_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
  `);

  // ─── Full-text search on memory_archive (Drizzle can't handle tsvector) ───

  // Ensure the tsvector column exists (Drizzle defines it as text)
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE memory_archive
        ALTER COLUMN search_vector TYPE tsvector USING search_vector::tsvector;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);

  // GIN index on the tsvector column
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_archive_search
      ON memory_archive USING GIN(search_vector);
  `);

  // Trigger to auto-update search_vector on insert/update
  await p.query(`
    CREATE OR REPLACE FUNCTION memory_archive_search_vector_update()
    RETURNS trigger AS $$
    BEGIN
      NEW.search_vector := to_tsvector(
        'french',
        coalesce(NEW.title, '') || ' ' ||
        coalesce(NEW.content, '') || ' ' ||
        coalesce(NEW.tags::text, '')
      );
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await p.query(`
    DROP TRIGGER IF EXISTS memory_archive_search_update ON memory_archive;
    CREATE TRIGGER memory_archive_search_update
      BEFORE INSERT OR UPDATE ON memory_archive
      FOR EACH ROW EXECUTE FUNCTION memory_archive_search_vector_update();
  `);

  // Backfill search_vector for existing rows that have NULL
  await p.query(`
    UPDATE memory_archive
    SET search_vector = to_tsvector(
      'french',
      coalesce(title, '') || ' ' ||
      coalesce(content, '') || ' ' ||
      coalesce(tags::text, '')
    )
    WHERE search_vector IS NULL;
  `);

  // ─── pgvector column on skills (Gemini text-embedding-004, 768 dims) ───
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE skills ADD COLUMN IF NOT EXISTS embedding vector(768);
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);
  // HNSW index — better recall and performance than IVFFlat for <100k rows
  await p.query(`
    CREATE INDEX IF NOT EXISTS skills_embedding_hnsw_idx
      ON skills USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
  `);

  // ─── pgvector column on memory_archive (Gemini text-embedding-004, 768 dims) ───
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE memory_archive ADD COLUMN IF NOT EXISTS embedding vector(768);
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS memory_archive_embedding_hnsw_idx
      ON memory_archive USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
  `);

  // ─── Full-text search on skills (name + description + tags) ───

  await p.query(`
    DO $$ BEGIN
      ALTER TABLE skills
        ALTER COLUMN search_vector TYPE tsvector USING search_vector::tsvector;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_skills_search
      ON skills USING GIN(search_vector);
  `);

  // Trigram indexes for fuzzy matching on skills
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_skills_name_trgm
      ON skills USING GIN(name gin_trgm_ops);
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_skills_description_trgm
      ON skills USING GIN(description gin_trgm_ops);
  `);

  // GIN index on tags jsonb array for @> containment queries
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_skills_tags_gin
      ON skills USING GIN(tags);
  `);

  // Trigger to auto-update search_vector on insert/update
  await p.query(`
    CREATE OR REPLACE FUNCTION skills_search_vector_update()
    RETURNS trigger AS $$
    BEGIN
      NEW.search_vector := to_tsvector(
        'french',
        coalesce(NEW.name, '') || ' ' ||
        coalesce(NEW.description, '') || ' ' ||
        coalesce(array_to_string(ARRAY(SELECT jsonb_array_elements_text(NEW.tags)), ' '), '')
      );
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await p.query(`
    DROP TRIGGER IF EXISTS skills_search_update ON skills;
    CREATE TRIGGER skills_search_update
      BEFORE INSERT OR UPDATE ON skills
      FOR EACH ROW EXECUTE FUNCTION skills_search_vector_update();
  `);

  // ─── Full-text search on mcp_tools (name + description) ───

  await p.query(`
    DO $$ BEGIN
      ALTER TABLE mcp_tools
        ALTER COLUMN search_vector TYPE tsvector USING search_vector::tsvector;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_mcp_tools_search
      ON mcp_tools USING GIN(search_vector);
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_mcp_tools_name_trgm
      ON mcp_tools USING GIN(name gin_trgm_ops);
  `);

  await p.query(`
    CREATE OR REPLACE FUNCTION mcp_tools_search_vector_update()
    RETURNS trigger AS $$
    BEGIN
      NEW.search_vector := to_tsvector(
        'english',
        coalesce(NEW.name, '') || ' ' ||
        replace(coalesce(NEW.name, ''), '_', ' ') || ' ' ||
        coalesce(NEW.description, '')
      );
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await p.query(`
    DROP TRIGGER IF EXISTS mcp_tools_search_update ON mcp_tools;
    CREATE TRIGGER mcp_tools_search_update
      BEFORE INSERT OR UPDATE ON mcp_tools
      FOR EACH ROW EXECUTE FUNCTION mcp_tools_search_vector_update();
  `);

  // ─── Routines: event-driven upgrade columns ───
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE routines ADD COLUMN IF NOT EXISTS webhook_secret text;
      ALTER TABLE routines ADD COLUMN IF NOT EXISTS server_managed boolean NOT NULL DEFAULT false;
      ALTER TABLE routines ADD COLUMN IF NOT EXISTS trigger_event text;
      ALTER TABLE routines ADD COLUMN IF NOT EXISTS trigger_config jsonb DEFAULT '{}';
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);

  // ─── Webhook events audit log table ───
  await p.query(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id text PRIMARY KEY,
      routine_id text NOT NULL,
      token text NOT NULL,
      source text,
      event text,
      status text NOT NULL,
      signature_valid boolean,
      http_status integer,
      payload_size integer,
      payload_preview text,
      error text,
      duration_ms integer,
      retry_count integer NOT NULL DEFAULT 0,
      ip text,
      created_at text NOT NULL DEFAULT now()::text
    );
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_webhook_events_routine
      ON webhook_events(routine_id);
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_webhook_events_token
      ON webhook_events(token);
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_webhook_events_created
      ON webhook_events(created_at);
  `);

  // ─── Watch state table (UBIK always-on awareness) ───
  await p.query(`
    CREATE TABLE IF NOT EXISTS watch_state (
      id text PRIMARY KEY,
      user_id text NOT NULL,
      service text NOT NULL,
      last_cursor text,
      last_checked_at text,
      last_notified_at text,
      enabled boolean NOT NULL DEFAULT true,
      config jsonb NOT NULL DEFAULT '{}',
      created_at text NOT NULL DEFAULT now()::text
    );
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_watch_state_user
      ON watch_state(user_id);
  `);

  // ─── JDR Module: Ensure new columns (idempotent ALTER) ───
  await p.query(`
    DO $$ BEGIN
      -- jdr_scenes
      ALTER TABLE jdr_scenes ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES jdr_locations(id);
      
      -- jdr_danger_clocks
      ALTER TABLE jdr_danger_clocks ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES jdr_locations(id);
      
      -- jdr_action_logs
      ALTER TABLE jdr_action_logs ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES jdr_locations(id);
      ALTER TABLE jdr_action_logs ADD COLUMN IF NOT EXISTS scene_id uuid REFERENCES jdr_scenes(id);
      
      -- jdr_quests
      ALTER TABLE jdr_quests ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES jdr_sessions(id);
      
      -- jdr_world_memories
      ALTER TABLE jdr_world_memories ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES jdr_sessions(id);
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);

  dbLogger.info("Tables ensured (Drizzle migrations + FTS triggers + JDR schema sync)");
}

/**
 * Close the database connection pool.
 */
export async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
    dbInstance = null;
    dbLogger.info("Connection pool closed");
  }
}
