const { z } = require("zod");

const memoryService = require("../server/services/memoryService");
const { MemoryTypeEnum, VisibilityEnum } = require("../server/schema/memoryObject");
const auth = require("../server/services/auth/callerAuth");
const cache = require("../server/services/cache/redisIndex");

/**
 * Registers Cortex's five tools on any MCP server instance, regardless
 * of transport (stdio for local testing, Streamable HTTP for the real
 * public A2MCP endpoint). One definition, two transports — keeps them
 * from drifting apart.
 */
function registerTools(server) {
  server.tool(
    "write_memory",
    "Permanently store a structured memory object for an agent. Anchored on Arweave (permanent storage) and X Layer (on-chain verification).",
    {
      agent_id: z.string().describe("Identifier of the agent this memory belongs to"),
      type: MemoryTypeEnum,
      content: z.string().max(50_000),
      metadata: z.record(z.any()).optional(),
      visibility: VisibilityEnum.optional(),
      tags: z.array(z.string()).optional(),
      notify_email: z.string().email().optional().describe("Optional email address to receive a one-time delivery notification of the written memory"),
      auth_signature: z.string().optional().describe("EVM wallet signature (required if CALLER_AUTH_ENFORCED=true)"),
      auth_timestamp: z.union([z.string(), z.number()]).optional().describe("Unix millisecond timestamp used in signature (required if CALLER_AUTH_ENFORCED=true)")
    },
    async (args) => {
      try {
        const record = await memoryService.writeMemory(args);
        return { content: [{ type: "text", text: JSON.stringify(record) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "recall_memory",
    "Retrieve a previously written memory object by its id, with on-chain verification that it hasn't been tampered with.",
    {
      id: z.string().describe("The memory's content-hash id, returned by write_memory"),
      cid: z.string().optional().describe("Optional IPFS CID for a faster lookup path"),
      auth_signature: z.string().optional().describe("EVM wallet signature (required for private memory)"),
      auth_timestamp: z.union([z.string(), z.number()]).optional().describe("Unix millisecond timestamp used in signature (required for private memory)")
    },
    async ({ id, cid, auth_signature, auth_timestamp }) => {
      try {
        const result = await memoryService.recallMemory(id, { cid, auth_signature, auth_timestamp });
        if (!result) {
          return { content: [{ type: "text", text: "Memory not found" }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "query_memory",
    "Query an agent's memory history, optionally filtered by type, date-range, and paginated.",
    {
      agent_id: z.string(),
      type: MemoryTypeEnum.optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
      from: z.string().optional().describe("ISO date string, start of date filter range"),
      to: z.string().optional().describe("ISO date string, end of date filter range"),
      auth_signature: z.string().optional().describe("EVM wallet signature (required if CALLER_AUTH_ENFORCED=true or if fetching private memory)"),
      auth_timestamp: z.union([z.string(), z.number()]).optional().describe("Unix millisecond timestamp used in signature")
    },
    async ({ agent_id, type, limit, offset, from, to, auth_signature, auth_timestamp }) => {
      try {
        const results = await memoryService.queryMemory(agent_id, {
          type,
          limit,
          offset,
          from,
          to,
          auth_signature,
          auth_timestamp
        });
        return { content: [{ type: "text", text: JSON.stringify({ results, count: results.length }) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_memory_digest",
    "Generate a compressed summary of an agent's memory history over a time range (Memory Decay feature). Raw memories are never deleted or altered — this creates an additional digest object, anchored the same way as any memory, with source_hashes pointing back to every original it summarizes for full audit.",
    {
      agent_id: z.string(),
      from: z.string().optional().describe("ISO date string, defaults to the beginning of history"),
      to: z.string().optional().describe("ISO date string, defaults to now"),
      auth_signature: z.string().optional().describe("EVM wallet signature (required if CALLER_AUTH_ENFORCED=true)"),
      auth_timestamp: z.union([z.string(), z.number()]).optional().describe("Unix millisecond timestamp used in signature (required if CALLER_AUTH_ENFORCED=true)")
    },
    async ({ agent_id, from, to, auth_signature, auth_timestamp }) => {
      try {
        const digest = await memoryService.generateDigest(agent_id, { from, to, auth_signature, auth_timestamp });
        if (!digest) {
          return { content: [{ type: "text", text: "No memories found in that range to summarize" }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(digest) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "list_my_agents",
    "List all namespaced agent IDs claimed/owned by your EVM wallet.",
    {
      auth_signature: z.string().describe("EVM wallet signature for list_my_agents"),
      auth_timestamp: z.union([z.string(), z.number()]).describe("Unix millisecond timestamp used in signature")
    },
    async ({ auth_signature, auth_timestamp }) => {
      try {
        const message = auth.buildListAgentsMessage(auth_timestamp);
        const recoveredWallet = auth.verifySignature(message, auth_signature, auth_timestamp);
        const agents = await cache.getAgentsByWallet(recoveredWallet);
        return { content: [{ type: "text", text: JSON.stringify({ agents }) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}

// Required (non-optional) argument names per tool, kept next to the schemas
// above so the two can't drift apart. Used by server/index.js's pre-payment
// MCP discovery gate to answer an incomplete tools/call for free instead of
// charging for a call that was always going to fail validation.
const TOOL_REQUIRED_FIELDS = {
  write_memory: ["agent_id", "type", "content"],
  recall_memory: ["id"],
  query_memory: ["agent_id"],
  get_memory_digest: ["agent_id"],
  list_my_agents: ["auth_signature", "auth_timestamp"]
};

module.exports = { registerTools, TOOL_REQUIRED_FIELDS };
