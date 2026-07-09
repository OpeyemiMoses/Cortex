const { MemoryObjectInput } = require("../schema/memoryObject");
const arweave = require("./storage/arweaveAdapter");
const ipfs = require("./storage/ipfsAdapter");
const registry = require("./registry/onchainRegistry");
const cache = require("./cache/redisIndex");

/**
 * These three functions are the actual product — everything else (Express
 * routes, the MCP server) is just a transport wrapper around them. Keeping
 * the logic here means the HTTP API and the MCP tool interface can never
 * drift apart.
 */

async function writeMemory(rawPayload) {
  const parsed = MemoryObjectInput.safeParse(rawPayload);
  if (!parsed.success) {
    const err = new Error("Invalid memory object");
    err.statusCode = 400;
    err.details = parsed.error.flatten();
    throw err;
  }

  const payload = parsed.data;

  // written_at and id come from the storage layer itself — it's the one
  // that actually computes the hash (with a uniqueness nonce baked in),
  // so this is the source of truth, not a separately-generated timestamp.
  const { id, arweave_tx_id, written_at } = await arweave.write(payload);

  const bodyForMirror = { ...payload, id, arweave_tx_id, written_at };
  const { cid } = await ipfs.pin(id, bodyForMirror);

  const { onchain_tx_hash } = await registry.anchor(payload.agent_id, id);

  const record = { ...bodyForMirror, ipfs_cid: cid, onchain_tx_hash };

  await cache.addToIndex(payload.agent_id, id);
  await cache.cacheSet(id, record);

  return record;
}

async function recallMemory(id, { cid } = {}) {
  let record = await cache.cacheGet(id);
  let source = record ? "cache" : null;

  if (!record && cid) {
    record = await ipfs.fetch(cid);
    source = record ? "ipfs" : null;
  }

  if (!record) {
    record = await arweave.read(id);
    source = record ? "arweave" : null;
    if (record) await cache.cacheSet(id, record);
  }

  if (!record) return null;

  const onchainAnchor = await registry.verify(id);
  return { memory: record, source, verified: !!onchainAnchor, onchain_anchor: onchainAnchor };
}

async function queryMemory(agentId, { type, limit = 20 } = {}) {
  const ids = await cache.getIndex(agentId);
  const records = [];

  for (const id of ids) {
    let record = await cache.cacheGet(id);
    if (!record) {
      record = await arweave.read(id);
      if (record) await cache.cacheSet(id, record);
    }
    if (record && (!type || record.type === type)) {
      records.push(record);
    }
  }

  return records.slice(0, limit);
}

/**
 * Memory Decay (MVP scope) — generates an on-demand compressed digest of
 * an agent's memory history over a time range. Deliberately scoped down
 * from the full feature spec for hackathon timeline safety:
 *   - On-demand, not a background cron job (simpler, nothing to schedule
 *     or monitor, same value in a demo).
 *   - Templated narrative, not LLM-generated (no new API dependency, no
 *     new failure surface).
 *   - No cache-tier eviction by age (Redis TTL already does something
 *     functionally similar).
 * What's preserved from the spec, and is the actual point: raw memories
 * are never touched — the digest is a new object, written through the
 * exact same writeMemory() pipeline (Arweave + on-chain anchor + Redis),
 * with source_hashes pointing back to every original it summarizes.
 */
async function generateDigest(agentId, { from, to } = {}) {
  const fromDate = from ? new Date(from) : new Date(0);
  const toDate = to ? new Date(to) : new Date();

  const ids = await cache.getIndex(agentId);
  const included = [];
  const typeCounts = {};

  for (const id of ids) {
    let record = await cache.cacheGet(id);
    if (!record) {
      record = await arweave.read(id);
      if (record) await cache.cacheSet(id, record);
    }

    // Never digest a digest — avoids double-counting and recursive rollups.
    if (!record || record.type === "digest") continue;

    const writtenAt = new Date(record.written_at);
    if (writtenAt < fromDate || writtenAt > toDate) continue;

    included.push(record);
    typeCounts[record.type] = (typeCounts[record.type] || 0) + 1;
  }

  if (included.length === 0) return null;

  const typeBreakdownStr = Object.entries(typeCounts)
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");

  const narrative = `Agent "${agentId}" recorded ${included.length} memories between ` +
    `${fromDate.toISOString().slice(0, 10)} and ${toDate.toISOString().slice(0, 10)} (${typeBreakdownStr}).`;

  return writeMemory({
    agent_id: agentId,
    type: "digest",
    content: narrative,
    metadata: {
      source_hashes: included.map((r) => r.id),
      source_count: included.length,
      type_breakdown: typeCounts,
      time_range: { from: fromDate.toISOString(), to: toDate.toISOString() }
    },
    visibility: "private",
    tags: ["digest"]
  });
}

module.exports = { writeMemory, recallMemory, queryMemory, generateDigest };
