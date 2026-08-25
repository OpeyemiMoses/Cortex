const { MemoryObjectInput, MemoryTypeEnum } = require("../schema/memoryObject");
const { TOOL_REQUIRED_FIELDS } = require("../../mcp/tools");
const memoryRoutes = require("../routes/memory");
const auth = require("../services/auth/callerAuth");

const CORTEX_MARKETPLACE_AGENT_ID = process.env.OKX_A2A_AGENT_ID || "4961";

/**
 * Pre-Payment Validation Middleware
 *
 * OKX.AI Listing Compliance Requirement:
 * Service parameter validation MUST happen before returning an x402 payment challenge (HTTP 402).
 * If a request is missing parameters or contains invalid fields, it must immediately return
 * HTTP 400 Bad Request so the buyer/client is not charged for an invalid call.
 */
function prePaymentValidator(req, res, next) {
  const path = req.path;
  const method = req.method;

  // ──────────────────────────────────────────────────────────────────────────
  // 1. /memory/write (POST and GET)
  // ──────────────────────────────────────────────────────────────────────────
  if (path === "/memory/write" || path === "/memory/write/") {
    const source = { ...(req.query || {}), ...(req.body || {}) };
    const normalized = memoryRoutes.normalize(source, {
      ...memoryRoutes.WRITE_ALIASES,
      ...memoryRoutes.AUTH_ALIASES
    });

    const parsed = MemoryObjectInput.safeParse(normalized);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(i => `${i.path.join(".") || "field"}: ${i.message}`).join(", ");
      return res.status(400).json({
        service: "cortex-write-memory",
        error: `Invalid memory object: ${issues}`,
        details: parsed.error.flatten()
      });
    }

    if (normalized.agent_id === CORTEX_MARKETPLACE_AGENT_ID) {
      return res.status(400).json({
        service: "cortex-write-memory",
        error: "invalid_agent_id",
        message: `agent_id cannot be the Cortex marketplace service ID ("${CORTEX_MARKETPLACE_AGENT_ID}"). Please provide your own unique agent ID.`
      });
    }

    if (process.env.CALLER_AUTH_ENFORCED === "true") {
      const { auth_signature, auth_timestamp, agent_id } = normalized;
      if (!auth_signature || !auth_timestamp) {
        return res.status(401).json({
          service: "cortex-write-memory",
          error: "auth_signature and auth_timestamp are required when CALLER_AUTH_ENFORCED=true."
        });
      }
      try {
        const isNamespaced = auth.isNamespaced(agent_id);
        const expectedWallet = isNamespaced ? auth.parseNamespaced(agent_id).wallet : null;
        const message = auth.buildWriteMessage(agent_id, auth_timestamp);
        const recoveredWallet = auth.verifySignature(message, auth_signature, auth_timestamp);

        if (expectedWallet && recoveredWallet !== expectedWallet) {
          return res.status(403).json({
            service: "cortex-write-memory",
            error: `agent_id "${agent_id}" is namespaced under wallet "${expectedWallet}". Writes must be signed by this wallet.`
          });
        }
      } catch (err) {
        return res.status(err.statusCode || 401).json({
          service: "cortex-write-memory",
          error: err.message
        });
      }
    }

    return next();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. /memory/recall (POST, GET /memory/recall, and GET /memory/recall/:id)
  // ──────────────────────────────────────────────────────────────────────────
  if (path === "/memory/recall" || path === "/memory/recall/" || path.startsWith("/memory/recall/")) {
    const source = { ...(req.query || {}), ...(req.body || {}) };
    const normalized = memoryRoutes.normalize(source, {
      ...memoryRoutes.RECALL_ALIASES,
      ...memoryRoutes.AUTH_ALIASES
    });

    let id = normalized.id;
    if (path.startsWith("/memory/recall/") && path.length > "/memory/recall/".length) {
      const pathId = decodeURIComponent(path.slice("/memory/recall/".length).split("?")[0].trim());
      if (pathId) {
        id = pathId;
      }
    }

    if (!id || typeof id !== "string" || id.trim() === "") {
      return res.status(400).json({
        service: "cortex-recall-memory",
        error: "missing_params",
        message: "id is required (pass as path parameter /memory/recall/:id, query parameter ?id=..., or JSON body { id })"
      });
    }

    return next();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 3. /memory/query (POST and GET)
  // ──────────────────────────────────────────────────────────────────────────
  if (path === "/memory/query" || path === "/memory/query/") {
    const source = { ...(req.query || {}), ...(req.body || {}) };
    const normalized = memoryRoutes.normalize(source, {
      ...memoryRoutes.AGENT_ID_ALIASES,
      ...memoryRoutes.AUTH_ALIASES,
      type: ["memoryType"]
    });

    if (!normalized.agent_id || typeof normalized.agent_id !== "string" || normalized.agent_id.trim() === "") {
      return res.status(400).json({
        service: "cortex-query-memory",
        error: "missing_params",
        message: "agent_id is required"
      });
    }

    if (normalized.agent_id === CORTEX_MARKETPLACE_AGENT_ID) {
      return res.status(400).json({
        service: "cortex-query-memory",
        error: "invalid_agent_id",
        message: `agent_id cannot be the Cortex marketplace service ID ("${CORTEX_MARKETPLACE_AGENT_ID}"). Please provide your own unique agent ID.`
      });
    }

    if (normalized.type) {
      const parsedType = MemoryTypeEnum.safeParse(normalized.type);
      if (!parsedType.success) {
        return res.status(400).json({
          service: "cortex-query-memory",
          error: "invalid_type",
          message: `Invalid memory type: "${normalized.type}". Must be one of: event, decision, outcome, preference, conversation, digest`
        });
      }
    }

    return next();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 4. /memory/digest (POST and GET)
  // ──────────────────────────────────────────────────────────────────────────
  if (path === "/memory/digest" || path === "/memory/digest/") {
    const source = { ...(req.query || {}), ...(req.body || {}) };
    const normalized = memoryRoutes.normalize(source, {
      ...memoryRoutes.AGENT_ID_ALIASES,
      ...memoryRoutes.AUTH_ALIASES
    });

    if (!normalized.agent_id || typeof normalized.agent_id !== "string" || normalized.agent_id.trim() === "") {
      return res.status(400).json({
        service: "cortex-memory-digest",
        error: "missing_params",
        message: "agent_id is required"
      });
    }

    if (normalized.agent_id === CORTEX_MARKETPLACE_AGENT_ID) {
      return res.status(400).json({
        service: "cortex-memory-digest",
        error: "invalid_agent_id",
        message: `agent_id cannot be the Cortex marketplace service ID ("${CORTEX_MARKETPLACE_AGENT_ID}"). Please provide your own unique agent ID.`
      });
    }

    return next();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 5. /memory/my-agents (POST and GET)
  // ──────────────────────────────────────────────────────────────────────────
  if (path === "/memory/my-agents" || path === "/memory/my-agents/") {
    const source = { ...(req.query || {}), ...(req.body || {}) };
    const normalized = memoryRoutes.normalize(source, {
      ...memoryRoutes.AUTH_ALIASES,
      ...memoryRoutes.MY_AGENTS_ALIASES
    });

    if (normalized.wallet && !memoryRoutes.WALLET_ADDRESS_RE.test(normalized.wallet)) {
      return res.status(400).json({
        service: "cortex-list-my-agents",
        error: "invalid_wallet",
        info: "wallet must be a 0x-prefixed, 40-hex-character EVM address."
      });
    }

    if (process.env.CALLER_AUTH_ENFORCED === "true" && !(normalized.auth_signature && normalized.auth_timestamp)) {
      return res.status(401).json({
        service: "cortex-list-my-agents",
        error: "missing_auth",
        info: "auth_signature and auth_timestamp are required when CALLER_AUTH_ENFORCED=true."
      });
    }

    return next();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 6. /mcp (POST)
  // ──────────────────────────────────────────────────────────────────────────
  if (path === "/mcp" || path === "/mcp/") {
    if (method !== "POST") return next();

    const body = req.body;
    const rpcId = body && body.id !== undefined ? body.id : null;

    if (!body || body.method !== "tools/call") {
      // Handshake / tools-list / initialize / ping — return informative 200 without payment charge
      return res.status(200).json({
        jsonrpc: "2.0",
        id: rpcId,
        result: {
          content: [{
            type: "text",
            text: "Cortex MCP: send a tools/call request with { name, arguments } to run a tool. A valid x402 payment header is required once the required arguments are included."
          }]
        }
      });
    }

    const toolName = body.params && body.params.name;
    const args = (body.params && body.params.arguments) || {};
    const required = TOOL_REQUIRED_FIELDS[toolName];

    if (required) {
      const missing = required.filter((key) => args[key] === undefined || args[key] === "");
      if (missing.length > 0) {
        return res.status(200).json({
          jsonrpc: "2.0",
          id: rpcId,
          result: {
            content: [{
              type: "text",
              text: `Missing required argument(s) for ${toolName}: ${missing.join(", ")}. A valid x402 payment header is required once they're included.`
            }],
            isError: true
          }
        });
      }

      if (args.agent_id === CORTEX_MARKETPLACE_AGENT_ID) {
        return res.status(200).json({
          jsonrpc: "2.0",
          id: rpcId,
          result: {
            content: [{
              type: "text",
              text: `Invalid agent_id "${CORTEX_MARKETPLACE_AGENT_ID}": this is the Cortex marketplace service ID. Please provide your own unique agent ID.`
            }],
            isError: true
          }
        });
      }

      // Additional schema check for write_memory tool in MCP
      if (toolName === "write_memory" && args.type) {
        const parsedType = MemoryTypeEnum.safeParse(args.type);
        if (!parsedType.success) {
          return res.status(200).json({
            jsonrpc: "2.0",
            id: rpcId,
            result: {
              content: [{
                type: "text",
                text: `Invalid type "${args.type}" for write_memory. Must be one of: event, decision, outcome, preference, conversation, digest`
              }],
              isError: true
            }
          });
        }
      }
    }

    return next();
  }

  return next();
}

module.exports = { prePaymentValidator };
