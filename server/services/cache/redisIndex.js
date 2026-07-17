/**
 * Index: agent_id -> list of memory ids (so query_memory doesn't need to
 * scan all of Arweave). Cache: id -> full memory record, short TTL, so
 * repeated recall_memory calls skip the Arweave/GraphQL round trip.
 *
 * Falls back to in-memory Maps automatically if REDIS_URL isn't set —
 * this means Phases 1-4 testing still works with zero Redis setup, and
 * you only need to stand up Redis once you want this to survive restarts.
 */

let redisClient = null;
let connecting = null;

const _memIndex = new Map(); // agent_id -> [ids]
const _memCache = new Map(); // id -> { value, expiresAt }
const _memWalletAgents = new Map(); // wallet -> Set(agent_ids)

async function getClient() {
  if (!process.env.REDIS_URL) return null;
  if (redisClient) return redisClient;
  if (connecting) return connecting;

  connecting = (async () => {
    const { createClient } = require("redis");
    const client = createClient({ url: process.env.REDIS_URL });
    client.on("error", (err) => console.error("Redis error:", err.message));
    await client.connect();
    console.log("Cortex: connected to Redis for index/cache layer.");
    redisClient = client;
    return client;
  })();

  return connecting;
}

async function addToIndex(agentId, memoryId) {
  const client = await getClient();
  if (client) {
    await client.rPush(`index:${agentId}`, memoryId);
    return;
  }
  if (!_memIndex.has(agentId)) _memIndex.set(agentId, []);
  _memIndex.get(agentId).push(memoryId);
}

async function getIndex(agentId) {
  const client = await getClient();
  if (client) {
    return client.lRange(`index:${agentId}`, 0, -1);
  }
  return _memIndex.get(agentId) || [];
}

async function cacheSet(id, value, ttlSeconds = 300) {
  const client = await getClient();
  if (client) {
    await client.set(`cache:${id}`, JSON.stringify(value), { EX: ttlSeconds });
    return;
  }
  _memCache.set(id, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

async function cacheGet(id) {
  const client = await getClient();
  if (client) {
    const raw = await client.get(`cache:${id}`);
    return raw ? JSON.parse(raw) : null;
  }
  const entry = _memCache.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _memCache.delete(id);
    return null;
  }
  return entry.value;
}

async function addAgentToWallet(wallet, agentId) {
  const client = await getClient();
  const key = `agents:${wallet.toLowerCase()}`;
  if (client) {
    await client.sAdd(key, agentId);
    return;
  }
  if (!_memWalletAgents.has(wallet.toLowerCase())) {
    _memWalletAgents.set(wallet.toLowerCase(), new Set());
  }
  _memWalletAgents.get(wallet.toLowerCase()).add(agentId);
}

async function getAgentsByWallet(wallet) {
  const client = await getClient();
  const key = `agents:${wallet.toLowerCase()}`;
  if (client) {
    return client.sMembers(key);
  }
  const set = _memWalletAgents.get(wallet.toLowerCase());
  return set ? Array.from(set) : [];
}

module.exports = {
  addToIndex,
  getIndex,
  cacheSet,
  cacheGet,
  addAgentToWallet,
  getAgentsByWallet
};
