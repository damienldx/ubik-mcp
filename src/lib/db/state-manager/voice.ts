import { and, desc, eq, genId, getDb, getPool, now, voiceProfiles, VoiceSampleRef } from "./shared";

export async function createVoiceProfile(userId: string, data: {
  name: string;
  slug: string;
  type?: "voice" | "style";
  description?: string;
  sampleSources?: VoiceSampleRef[];
  sampleCount?: number;
  totalDurationSec?: number;
}) {
  const db = getDb();
  const id = genId("vp");
  await db.insert(voiceProfiles).values({
    id,
    userId,
    name: data.name,
    slug: data.slug,
    type: data.type || "voice",
    status: "pending",
    description: data.description || "",
    sampleSources: data.sampleSources || [],
    sampleCount: data.sampleCount || 0,
    totalDurationSec: data.totalDurationSec || 0,
    createdAt: now(),
    updatedAt: now(),
  });
  return { id };
}

export async function listVoiceProfiles(userId: string) {
  return getDb().select().from(voiceProfiles).where(eq(voiceProfiles.userId, userId)).orderBy(desc(voiceProfiles.createdAt));
}

export async function getVoiceProfile(userId: string, profileId: string) {
  const [row] = await getDb().select().from(voiceProfiles).where(and(eq(voiceProfiles.id, profileId), eq(voiceProfiles.userId, userId))).limit(1);
  return row ?? null;
}

export async function getVoiceProfileBySlug(userId: string, slug: string) {
  const [row] = await getDb().select().from(voiceProfiles).where(and(eq(voiceProfiles.slug, slug), eq(voiceProfiles.userId, userId))).limit(1);
  return row ?? null;
}

export async function updateVoiceProfile(userId: string, profileId: string, updates: Record<string, any>) {
  const allowed = ["name", "slug", "status", "chatterbox_voice_id", "sample_sources", "sample_count", "total_duration_sec", "gpu_job_id", "gpu_cost_estimate", "description", "error"];
  const sets: string[] = [];
  const vals: any[] = [];
  let paramIdx = 1;
  for (const [key, value] of Object.entries(updates)) {
    if (allowed.includes(key)) {
      sets.push(`${key} = $${paramIdx}`);
      vals.push(typeof value === "object" && value !== null ? JSON.stringify(value) : value);
      paramIdx++;
    }
  }
  if (sets.length === 0) return;
  sets.push(`updated_at = $${paramIdx}`);
  vals.push(now());
  const idIdx = ++paramIdx;
  vals.push(profileId);
  const userIdx = ++paramIdx;
  vals.push(userId);
  await getPool().query(`UPDATE voice_profiles SET ${sets.join(", ")} WHERE id = $${idIdx} AND user_id = $${userIdx}`, vals);
}

export async function deleteVoiceProfile(userId: string, profileId: string) {
  await getDb().delete(voiceProfiles).where(and(eq(voiceProfiles.id, profileId), eq(voiceProfiles.userId, userId)));
}
