import { and, eq, genId, getDb, getPool, now, userAddons } from "./shared";

export async function getUserAddons(userId: string): Promise<Array<{ addonId: string; enabled: boolean; installedAt: string }>> {
  const rows = await getDb().select().from(userAddons).where(eq(userAddons.userId, userId));
  return rows.map((row) => ({ addonId: row.addonId, enabled: row.enabled, installedAt: row.installedAt }));
}

export async function toggleAddon(userId: string, addonId: string, enabled: boolean) {
  const pool = getPool();
  const id = genId("addon");
  await pool.query(`
    INSERT INTO user_addons (id, user_id, addon_id, enabled, installed_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (user_id, addon_id)
    DO UPDATE SET enabled = EXCLUDED.enabled
  `, [id, userId, addonId, enabled, now()]);
}

export async function isAddonEnabled(userId: string, addonId: string): Promise<boolean> {
  const [row] = await getDb().select().from(userAddons).where(and(eq(userAddons.userId, userId), eq(userAddons.addonId, addonId))).limit(1);
  return row?.enabled ?? false;
}

export async function getDiscordAgentConfig(userId: string): Promise<{
  guildId: string | null;
  guildName: string;
  channelId: string | null;
  enabled: boolean;
  systemPrompt: string | null;
  maxToolIterations: number;
} | null> {
  const res = await getPool().query(
    "SELECT guild_id, guild_name, channel_id, enabled, system_prompt, max_tool_iterations FROM discord_agent WHERE user_id = $1 LIMIT 1",
    [userId],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    guildId: row.guild_id,
    guildName: row.guild_name,
    channelId: row.channel_id,
    enabled: row.enabled,
    systemPrompt: row.system_prompt,
    maxToolIterations: row.max_tool_iterations,
  };
}

export async function upsertDiscordAgentConfig(userId: string, data: {
  guildId?: string;
  guildName?: string;
  channelId?: string;
  enabled?: boolean;
  systemPrompt?: string;
}): Promise<void> {
  const pool = getPool();
  const timestamp = new Date().toISOString();
  const id = `dc-agent-${userId}`;
  await pool.query(`
    INSERT INTO discord_agent (id, user_id, guild_id, guild_name, channel_id, enabled, system_prompt, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
    ON CONFLICT (user_id) DO UPDATE SET
      guild_id = COALESCE($3, discord_agent.guild_id),
      guild_name = COALESCE($4, discord_agent.guild_name),
      channel_id = COALESCE($5, discord_agent.channel_id),
      enabled = COALESCE($6, discord_agent.enabled),
      system_prompt = COALESCE($7, discord_agent.system_prompt),
      updated_at = $8
  `, [id, userId, data.guildId ?? null, data.guildName ?? null, data.channelId ?? null, data.enabled ?? true, data.systemPrompt ?? null, timestamp]);
}
