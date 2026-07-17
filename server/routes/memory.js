const express = require("express");
const router = express.Router();

const memoryService = require("../services/memoryService");
const cache = require("../services/cache/redisIndex");
const auth = require("../services/auth/callerAuth");

/**
 * No payment gating here — when PAYMENTS_ENFORCED=true, the OKX Onchain OS
 * payment middleware is mounted globally in server/index.js and intercepts
 * unpaid requests before they ever reach these handlers.
 */

router.post("/write", async (req, res) => {
  try {
    const record = await memoryService.writeMemory(req.body);
    res.status(201).json({ memory: record });
  } catch (err) {
    if (err.statusCode === 400) {
      return res.status(400).json({ error: err.message, details: err.details });
    }
    if (err.statusCode === 401 || err.statusCode === 403) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error("write_memory failed:", err);
    res.status(500).json({ error: "Failed to write memory" });
  }
});

router.get("/recall/:id", async (req, res) => {
  try {
    const { cid, auth_signature, auth_timestamp } = req.query;
    const result = await memoryService.recallMemory(req.params.id, {
      cid,
      auth_signature,
      auth_timestamp
    });
    if (!result) return res.status(404).json({ error: "Memory not found" });
    res.json(result);
  } catch (err) {
    if (err.statusCode === 401 || err.statusCode === 403) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error("recall_memory failed:", err);
    res.status(500).json({ error: "Failed to recall memory" });
  }
});

router.get("/query", async (req, res) => {
  const { agent_id, type, limit, offset, from, to, auth_signature, auth_timestamp } = req.query;
  if (!agent_id) return res.status(400).json({ error: "agent_id is required" });

  try {
    const results = await memoryService.queryMemory(agent_id, {
      type,
      limit: limit ? parseInt(limit, 10) : 20,
      offset: offset ? parseInt(offset, 10) : 0,
      from,
      to,
      auth_signature,
      auth_timestamp
    });
    res.json({ results, count: results.length });
  } catch (err) {
    if (err.statusCode === 401 || err.statusCode === 403) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error("query_memory failed:", err);
    res.status(500).json({ error: "Failed to query memory" });
  }
});

/**
 * GET /memory/digest?agent_id=...&from=...&to=...
 */
router.get("/digest", async (req, res) => {
  const { agent_id, from, to, auth_signature, auth_timestamp } = req.query;
  if (!agent_id) return res.status(400).json({ error: "agent_id is required" });

  try {
    const digest = await memoryService.generateDigest(agent_id, {
      from,
      to,
      auth_signature,
      auth_timestamp
    });
    if (!digest) return res.status(404).json({ error: "No memories found in that range to summarize" });
    res.json({ digest });
  } catch (err) {
    if (err.statusCode === 401 || err.statusCode === 403) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error("get_memory_digest failed:", err);
    res.status(500).json({ error: "Failed to generate digest" });
  }
});

/**
 * GET /memory/my-agents
 */
router.get("/my-agents", async (req, res) => {
  const { auth_signature, auth_timestamp } = req.query;
  if (!auth_signature || !auth_timestamp) {
    return res.status(401).json({ error: "auth_signature and auth_timestamp are required." });
  }

  try {
    const message = auth.buildListAgentsMessage(auth_timestamp);
    const recoveredWallet = auth.verifySignature(message, auth_signature, auth_timestamp);
    const agents = await cache.getAgentsByWallet(recoveredWallet);
    res.json({ agents });
  } catch (err) {
    if (err.statusCode === 401 || err.statusCode === 403) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error("my-agents failed:", err);
    res.status(500).json({ error: "Failed to list owned agents" });
  }
});

module.exports = router;
