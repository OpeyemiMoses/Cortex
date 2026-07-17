const { z } = require("zod");

/**
 * Cortex Memory Object — the single data contract every write/recall/query
 * call is built around. Keep this stable; other agents integrate against it.
 *
 * Design notes:
 * - `id` is content-addressed (hash of the canonical payload) once written —
 *   generated server-side in the storage layer, not supplied by the caller.
 * - `prior_hash` lets an agent chain memories (e.g. a decision log) so
 *   tampering with history breaks the chain, not just a single record.
 * - `embedding` is optional and only needed if query_memory does semantic
 *   search rather than structured filtering.
 * - `visibility` controls whether other agents can recall this object
 *   (see access control decision in the scoping brief, section 8).
 */

const MemoryTypeEnum = z.enum([
  "event",       // something that happened (a trade executed, a tx observed)
  "decision",    // a choice the agent made and why
  "outcome",     // the result of a prior decision (for learning/audit loops)
  "preference",  // a learned user/agent preference
  "conversation", // a summarized exchange
  "digest"       // a compressed rollup of older memories (Memory Decay feature) —
                 // never generated FROM other digests, and never replaces the
                 // raw memories it summarizes; see memoryService.generateDigest
]);

const VisibilityEnum = z.enum(["private", "public", "permissioned"]);

const MemoryObjectInput = z.object({
  agent_id: z.string().min(1, "agent_id is required"),
  type: MemoryTypeEnum,
  content: z.string().min(1, "content is required").max(50_000),
  metadata: z.record(z.any()).optional().default({}),
  prior_hash: z.string().optional().nullable(),
  visibility: VisibilityEnum.optional().default("private"),
  embedding: z.array(z.number()).optional(),
  tags: z.array(z.string()).optional().default([]),
  auth_signature: z.string().optional(),
  auth_timestamp: z.union([z.string(), z.number()]).optional()
});

// Shape of a memory object once it has been written and anchored.
const MemoryObjectRecord = MemoryObjectInput.extend({
  id: z.string(),              // content hash, e.g. sha256 of canonical payload
  arweave_tx_id: z.string().nullable(),
  ipfs_cid: z.string().nullable(),
  onchain_tx_hash: z.string().nullable(),
  written_at: z.string() // ISO 8601
});

module.exports = {
  MemoryTypeEnum,
  VisibilityEnum,
  MemoryObjectInput,
  MemoryObjectRecord
};
