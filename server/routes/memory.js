const express = require("express");
const router = express.Router();

const memoryService = require("../services/memoryService");

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
    console.error("write_memory failed:", err);
    res.status(500).json({ error: "Failed to write memory" });
  }
});

router.get("/recall/:id", async (req, res) => {
  try {
    const result = await memoryService.recallMemory(req.params.id, { cid: req.query.cid });
    if (!result) return res.status(404).json({ error: "Memory not found" });
    res.json(result);
  } catch (err) {
    console.error("recall_memory failed:", err);
    res.status(500).json({ error: "Failed to recall memory" });
  }
});

router.get("/query", async (req, res) => {
  const { agent_id, type, limit } = req.query;
  if (!agent_id) return res.status(400).json({ error: "agent_id is required" });

  try {
    const results = await memoryService.queryMemory(agent_id, {
      type,
      limit: limit ? parseInt(limit, 10) : 20
    });
    res.json({ results, count: results.length });
  } catch (err) {
    console.error("query_memory failed:", err);
    res.status(500).json({ error: "Failed to query memory" });
  }
});

/**
 * GET /memory/digest?agent_id=...&from=...&to=...
 * Memory Decay (MVP) — see memoryService.generateDigest for the full
 * reasoning. from/to are optional ISO date strings.
 */
router.get("/digest", async (req, res) => {
  const { agent_id, from, to } = req.query;
  if (!agent_id) return res.status(400).json({ error: "agent_id is required" });

  try {
    const digest = await memoryService.generateDigest(agent_id, { from, to });
    if (!digest) return res.status(404).json({ error: "No memories found in that range to summarize" });
    res.json({ digest });
  } catch (err) {
    console.error("get_memory_digest failed:", err);
    res.status(500).json({ error: "Failed to generate digest" });
  }
});

module.exports = router;
