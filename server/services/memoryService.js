const { MemoryObjectInput } = require("../schema/memoryObject");
const arweave = require("./storage/arweaveAdapter");
const ipfs = require("./storage/ipfsAdapter");
const registry = require("./registry/onchainRegistry");
const cache = require("./cache/redisIndex");
const auth = require("./auth/callerAuth");

/**
 * These three functions are the actual product — everything else (Express
 * routes, the MCP server) is just a transport wrapper around them. Keeping
 * the logic here means the HTTP API and the MCP tool interface can never
 * drift apart.
 */

async function writeMemory(rawPayload, options = {}) {
  const parsed = MemoryObjectInput.safeParse(rawPayload);
  if (!parsed.success) {
    const err = new Error("Invalid memory object");
    err.statusCode = 400;
    err.details = parsed.error.flatten();
    throw err;
  }

  const payload = parsed.data;

  let recoveredWallet = null;
  if (process.env.CALLER_AUTH_ENFORCED === "true" && !options.skipAuth) {
    const { auth_signature, auth_timestamp, agent_id } = payload;
    if (!auth_signature || !auth_timestamp) {
      const err = new Error("auth_signature and auth_timestamp are required when CALLER_AUTH_ENFORCED=true.");
      err.statusCode = 401;
      throw err;
    }

    const isNamespaced = auth.isNamespaced(agent_id);
    const expectedWallet = isNamespaced ? auth.parseNamespaced(agent_id).wallet : null;

    const message = auth.buildWriteMessage(agent_id, auth_timestamp);
    recoveredWallet = auth.verifySignature(message, auth_signature, auth_timestamp);

    if (expectedWallet && recoveredWallet !== expectedWallet) {
      const err = new Error(`agent_id "${agent_id}" is namespaced under wallet "${expectedWallet}". Writes must be signed by this wallet.`);
      err.statusCode = 403;
      throw err;
    }

    payload.agent_id = auth.getNamespacedId(agent_id, recoveredWallet);
  }

  // Strip auth credentials before saving/hashing
  delete payload.auth_signature;
  delete payload.auth_timestamp;

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

  // If a wallet claimed/wrote to this agent, track the mapping so
  // "my agents" can find it later. Priority: a signature-recovered wallet
  // (CALLER_AUTH_ENFORCED=true) > an already-namespaced agent_id > the
  // wallet that paid for this call via x402. The last one is what keeps
  // this working under CALLER_AUTH_ENFORCED=false (the current production
  // setting) — otherwise the index never gets populated at all.
  const walletForIndex =
    recoveredWallet ||
    (auth.isNamespaced(payload.agent_id) ? auth.parseNamespaced(payload.agent_id).wallet : null) ||
    options.payerAddress ||
    null;

  if (walletForIndex) {
    await cache.addAgentToWallet(walletForIndex, payload.agent_id);
  }

  return record;
}

async function recallMemory(id, { cid, auth_signature, auth_timestamp } = {}) {
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

  // Enforce read-side visibility auth
  const visibility = record.visibility || "public";
  if (process.env.CALLER_AUTH_ENFORCED === "true" && visibility === "private") {
    const isNamespaced = auth.isNamespaced(record.agent_id);
    if (isNamespaced) {
      const { wallet: ownerWallet } = auth.parseNamespaced(record.agent_id);
      if (!auth_signature || !auth_timestamp) {
        const err = new Error("auth_signature and auth_timestamp are required to recall a private memory.");
        err.statusCode = 401;
        throw err;
      }
      const message = auth.buildReadMessage(id, auth_timestamp);
      const recoveredWallet = auth.verifySignature(message, auth_signature, auth_timestamp);
      if (recoveredWallet !== ownerWallet) {
        const err = new Error("Access denied: You do not own the wallet that created this private memory.");
        err.statusCode = 403;
        throw err;
      }
    } else {
      const err = new Error("Access denied: Legacy private memory cannot be recalled under caller auth.");
      err.statusCode = 403;
      throw err;
    }
  }

  const onchainAnchor = await registry.verify(id);
  return { memory: record, source, verified: !!onchainAnchor, onchain_anchor: onchainAnchor };
}

async function queryMemory(agentId, { type, limit = 20, offset = 0, from, to, auth_signature, auth_timestamp } = {}) {
  let resolvedAgentId = agentId;
  let isOwner = false;

  if (process.env.CALLER_AUTH_ENFORCED === "true") {
    const isNamespaced = auth.isNamespaced(agentId);
    if (!isNamespaced) {
      if (!auth_signature || !auth_timestamp) {
        const err = new Error("auth_signature and auth_timestamp are required to query memories when CALLER_AUTH_ENFORCED=true.");
        err.statusCode = 401;
        throw err;
      }
      const message = auth.buildReadMessage(agentId, auth_timestamp);
      const recoveredWallet = auth.verifySignature(message, auth_signature, auth_timestamp);
      resolvedAgentId = auth.getNamespacedId(agentId, recoveredWallet);
      isOwner = true;
    } else {
      const { wallet: ownerWallet } = auth.parseNamespaced(agentId);
      if (auth_signature && auth_timestamp) {
        const message = auth.buildReadMessage(agentId, auth_timestamp);
        try {
          const recoveredWallet = auth.verifySignature(message, auth_signature, auth_timestamp);
          isOwner = recoveredWallet === ownerWallet;
        } catch {
          isOwner = false;
        }
      } else {
        isOwner = false;
      }
      resolvedAgentId = agentId;
    }
  } else {
    isOwner = true;
    if (auth_signature && auth_timestamp) {
      try {
        const message = auth.buildReadMessage(agentId, auth_timestamp);
        const recoveredWallet = auth.verifySignature(message, auth_signature, auth_timestamp);
        resolvedAgentId = auth.getNamespacedId(agentId, recoveredWallet);
      } catch {}
    }
  }

  const ids = await cache.getIndex(resolvedAgentId);
  const records = [];

  for (const id of ids) {
    let record = await cache.cacheGet(id);
    if (!record) {
      record = await arweave.read(id);
      if (record) await cache.cacheSet(id, record);
    }
    if (!record) continue;

    // Visibility filter
    const visibility = record.visibility || "public";
    if (process.env.CALLER_AUTH_ENFORCED === "true" && visibility === "private" && !isOwner) {
      continue; // Skip private memory for non-owner
    }

    // Date range filter
    const writtenAt = new Date(record.written_at);
    if (from && writtenAt < new Date(from)) continue;
    if (to && writtenAt > new Date(to)) continue;

    // Type filter
    if (type && record.type !== type) continue;

    records.push(record);
  }

  return records.slice(offset, offset + limit);
}

/**
 * Memory Decay (MVP scope) — generates an on-demand compressed digest of
 * an agent's memory history over a time range.
 */
async function generateDigest(agentId, { from, to, auth_signature, auth_timestamp } = {}) {
  let resolvedAgentId = agentId;

  // Enforce read authorization to generate a digest
  if (process.env.CALLER_AUTH_ENFORCED === "true") {
    const isNamespaced = auth.isNamespaced(agentId);
    if (!isNamespaced) {
      if (!auth_signature || !auth_timestamp) {
        const err = new Error("auth_signature and auth_timestamp are required to generate a memory digest.");
        err.statusCode = 401;
        throw err;
      }
      const message = auth.buildReadMessage(agentId, auth_timestamp);
      const recoveredWallet = auth.verifySignature(message, auth_signature, auth_timestamp);
      resolvedAgentId = auth.getNamespacedId(agentId, recoveredWallet);
    } else {
      const { wallet: ownerWallet } = auth.parseNamespaced(agentId);
      if (!auth_signature || !auth_timestamp) {
        const err = new Error("auth_signature and auth_timestamp are required to generate a memory digest of a namespaced agent.");
        err.statusCode = 401;
        throw err;
      }
      const message = auth.buildReadMessage(agentId, auth_timestamp);
      const recoveredWallet = auth.verifySignature(message, auth_signature, auth_timestamp);
      if (recoveredWallet !== ownerWallet) {
        const err = new Error("Access denied: You do not own the wallet for this agent.");
        err.statusCode = 403;
        throw err;
      }
      resolvedAgentId = agentId;
    }
  }

  const fromDate = from ? new Date(from) : new Date(0);
  const toDate = to ? new Date(to) : new Date();

  // Retrieve all records for range check (passing auth credentials so queryMemory doesn't reject)
  const records = await queryMemory(resolvedAgentId, {
    from,
    to,
    limit: 10000,
    auth_signature,
    auth_timestamp
  });

  const included = [];
  const typeCounts = {};

  for (const record of records) {
    // Never digest a digest — avoids double-counting and recursive rollups.
    if (record.type === "digest") continue;

    included.push(record);
    typeCounts[record.type] = (typeCounts[record.type] || 0) + 1;
  }

  if (included.length === 0) return null;

  const typeBreakdownStr = Object.entries(typeCounts)
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");

  const narrative = `Agent "${resolvedAgentId}" recorded ${included.length} memories between ` +
    `${fromDate.toISOString().slice(0, 10)} and ${toDate.toISOString().slice(0, 10)} (${typeBreakdownStr}).`;

  return writeMemory({
    agent_id: resolvedAgentId,
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
  }, { skipAuth: true });
}

module.exports = { writeMemory, recallMemory, queryMemory, generateDigest };
