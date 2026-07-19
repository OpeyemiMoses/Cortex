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

/**
 * The marketplace's automatic x402 replay builds its request body from the
 * human-readable serviceParams text (e.g. "agent ID" -> agentId, "memory
 * type" -> memoryType), which doesn't match this API's snake_case wire
 * format. Accept the camelCase alias alongside the canonical key so a
 * designated-task replay doesn't bounce on field naming alone.
 */
function normalize(params, aliasMap) {
  const out = { ...params };
  for (const [canonical, aliases] of Object.entries(aliasMap)) {
    if (out[canonical] === undefined) {
      for (const alias of aliases) {
        if (out[alias] !== undefined) {
          out[canonical] = out[alias];
          break;
        }
      }
    }
  }
  return out;
}

const AGENT_ID_ALIASES = { agent_id: ["agentId"] };
const WRITE_ALIASES = {
  agent_id: ["agentId"],
  type: ["memoryType"],
  content: ["memoryContent"]
};
const RECALL_ALIASES = { id: ["memoryId"], cid: ["ipfsCid"] };
const AUTH_ALIASES = { auth_signature: ["authSignature"], auth_timestamp: ["authTimestamp"] };

router.post("/write", async (req, res) => {
  try {
    const record = await memoryService.writeMemory(normalize(req.body, { ...WRITE_ALIASES, ...AUTH_ALIASES }));
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

// GET fallback — write is a mutation and can't execute from a bare GET, but
// the marketplace's x402 reachability pre-check (x402-validate) probes with
// a plain GET before ever attempting the real paid POST. Without this, that
// pre-check 404s and the whole designated-task flow is refused before it
// gets anywhere near payment.
router.get("/write", (req, res) => {
  res.json({
    service: "cortex-write-memory",
    info: "Send a POST with a JSON body (agent_id, type, content, visibility) to write a memory. A valid x402 payment header is required."
  });
});

async function handleRecall(id, params, res) {
  try {
    const { cid, auth_signature, auth_timestamp } = params;
    const result = await memoryService.recallMemory(id, { cid, auth_signature, auth_timestamp });
    if (!result) return res.status(404).json({ error: "Memory not found" });
    res.json(result);
  } catch (err) {
    if (err.statusCode === 401 || err.statusCode === 403) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error("recall_memory failed:", err);
    res.status(500).json({ error: "Failed to recall memory" });
  }
}

router.get("/recall/:id", (req, res) => handleRecall(req.params.id, normalize(req.query, AUTH_ALIASES), res));

// POST variant — lets an x402-gated marketplace replay (which sends a JSON
// body, not a path param or query string) call this service directly.
router.post("/recall", (req, res) => {
  const body = normalize(req.body, { ...RECALL_ALIASES, ...AUTH_ALIASES });
  const { id } = body;
  if (!id) return res.status(400).json({ error: "id is required" });
  return handleRecall(id, body, res);
});

// Bare GET fallback (no :id) — same reachability-probe reasoning as
// GET /write above: x402-validate's plain GET has nothing to recall by, so
// this just confirms the endpoint is a real x402 service.
router.get("/recall", (req, res) => {
  res.json({
    service: "cortex-recall-memory",
    info: "Send a POST with a JSON body ({ id }) or GET /memory/recall/:id to recall a memory. A valid x402 payment header is required."
  });
});

async function handleQuery(params, res) {
  const { agent_id, type, limit, offset, from, to, auth_signature, auth_timestamp } = params;
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
}

router.get("/query", (req, res) => handleQuery(normalize(req.query, { ...AGENT_ID_ALIASES, ...AUTH_ALIASES }), res));
router.post("/query", (req, res) => handleQuery(normalize(req.body, { ...AGENT_ID_ALIASES, ...AUTH_ALIASES }), res));

/**
 * /memory/digest?agent_id=...&from=...&to=... (GET) or the same fields
 * as a JSON body (POST).
 */
async function handleDigest(params, res) {
  const { agent_id, from, to, auth_signature, auth_timestamp } = params;
  if (!agent_id) return res.status(400).json({ error: "agent_id is required" });

  try {
    const digest = await memoryService.generateDigest(agent_id, { from, to, auth_signature, auth_timestamp });
    if (!digest) return res.status(404).json({ error: "No memories found in that range to summarize" });
    res.json({ digest });
  } catch (err) {
    if (err.statusCode === 401 || err.statusCode === 403) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error("get_memory_digest failed:", err);
    res.status(500).json({ error: "Failed to generate digest" });
  }
}

router.get("/digest", (req, res) => handleDigest(normalize(req.query, { ...AGENT_ID_ALIASES, ...AUTH_ALIASES }), res));
router.post("/digest", (req, res) => handleDigest(normalize(req.body, { ...AGENT_ID_ALIASES, ...AUTH_ALIASES }), res));

async function handleMyAgents(params, res) {
  const { auth_signature, auth_timestamp } = params;
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
}

router.get("/my-agents", (req, res) => handleMyAgents(normalize(req.query, AUTH_ALIASES), res));
router.post("/my-agents", (req, res) => handleMyAgents(normalize(req.body, AUTH_ALIASES), res));

module.exports = router;
