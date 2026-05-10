/**
 * Database — Public API
 *
 * Point d'import unique pour toutes les opérations DB.
 * Système de mémoire contextuelle persistante UBIK Cyber Punk.
 */

export { getDb, getPool, closeDb, ensureTables } from "./connection";

// State Manager — Cerveau Collectif
export {
  // DAGs
  createDag,
  getDag,
  updateDagStatus,
  addDagNode,
  updateNodeStatus,
  // SharedContext
  getSharedContext,
  commitNodeOutput,
  setSharedGlobal,
  getContextForNode,
  // Event Bus
  publishEvent,
  getEventsForNode,
  markEventProcessed,
  // Layer 0 — Atoms
  createAtom,
  getAtom,
  getAtomsByTask,
  searchAtoms,
  // Layer 1 — Tasks
  createTask,
  getTask,
  listTasks,
  updateTaskStatus,
  // Layer 2 — Projects
  createProject,
  getProject,
  listProjects,
  updateProject,
  // Layer 3 — Global
  getGlobalContext,
  updateGlobalContext,
  // Interactions
  recordInteraction,
  getRecentInteractions,
  // Mémoire Vive
  writeToLiveMemory,
  getLiveMemory,
  purgeLiveMemory,
  clearLiveMemory,
  // Mémoire Longue (Archive)
  createArchiveEntry,
  getArchiveEntries,
  deleteArchiveEntry,
  searchArchive,
  // Expert Patterns
  createExpertPattern,
  listExpertPatterns,
  getExpertPattern,
  updateExpertPattern,
  deleteExpertPattern,
  // Expert Embeddings — RAG
  indexExpertDocument,
  searchExpertDocs,
  hasExpertEmbeddings,
  // Voice Profiles — Fine-tuning
  createVoiceProfile,
  listVoiceProfiles,
  getVoiceProfile,
  getVoiceProfileBySlug,
  updateVoiceProfile,
  deleteVoiceProfile,
} from "./state-manager";

// Session Tracker
export {
  trackSessionStart,
  trackSessionEnd,
  trackInput,
  trackOutput,
  onContextEvent,
  getTrackedSessions,
  type TrackedSession,
  type ContextEvent,
} from "./session-tracker";

// Schema (for Drizzle Kit)
export * as schema from "./schema";
