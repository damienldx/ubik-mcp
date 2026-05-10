/**
 * RLS Context Helper — PostgreSQL Row-Level Security
 *
 * Sets `app.current_user_id` GUC variable per-transaction so that
 * RLS policies can filter rows by the authenticated user.
 *
 * Usage:
 *   await withRlsContext(userId, async () => {
 *     return db.select().from(projects);
 *   });
 */

import { sql } from "drizzle-orm";
import { getDb, getPool } from "./connection";

// Creator email — bypasses RLS to see all tenant data
const CREATOR_EMAIL = "damienldx@gmail.com";

/** Check if a userId belongs to the creator (cached after first lookup) */
let _creatorUserId: string | null | undefined;
export async function isCreatorUser(userId: string): Promise<boolean> {
  if (_creatorUserId === undefined) {
    const pool = getPool();
    const res = await pool.query("SELECT id FROM users WHERE email = $1 AND role = 'creator' LIMIT 1", [CREATOR_EMAIL]);
    _creatorUserId = res.rows[0]?.id ?? null;
  }
  return _creatorUserId === userId;
}

/**
 * Sets the current user ID for RLS policies.
 * Must be called at the beginning of each request/transaction.
 *
 * NOTE: Uses SET LOCAL so the setting is scoped to the current transaction.
 * If called outside a transaction, use SET (session-level) instead.
 */
export async function setRlsContext(userId: string) {
  const db = getDb();
  await db.execute(sql`SET LOCAL app.current_user_id = ${userId}`);
}

/**
 * Wraps a database operation with RLS context.
 * Begins a transaction, sets the user context, runs the operation, then commits.
 *
 * This is the recommended way to run user-scoped queries:
 *
 * @example
 * const userProjects = await withRlsContext(userId, async () => {
 *   return db.select().from(projects);
 * });
 */
export async function withRlsContext<T>(
  userId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const db = getDb();

  return await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.current_user_id = ${userId}`);
    return await operation();
  });
}

/**
 * Clears the RLS context (sets user ID to empty string).
 * Useful for cleanup in tests or error handlers.
 */
export async function clearRlsContext() {
  const db = getDb();
  await db.execute(sql`RESET app.current_user_id`);
}
