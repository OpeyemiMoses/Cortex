const { z } = require("zod");

const memoryService = require("../server/services/memoryService");
const { MemoryTypeEnum, VisibilityEnum } = require("../server/schema/memoryObject");

/**
 * Registers Cortex's three tools on any MCP server instance, regardless
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
      tags: z.array(z.string()).optional()
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
      cid: z.string().optional().describe("Optional IPFS CID for a faster lookup path")
    },
    async ({ id, cid }) => {
      try {
        const result = await memoryService.recallMemory(id, { cid });
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
    "Query an agent's memory history, optionally filtered by type.",
    {
      agent_id: z.string(),
      type: MemoryTypeEnum.optional(),
      limit: z.number().optional()
    },
    async ({ agent_id, type, limit }) => {
      try {
        const results = await memoryService.queryMemory(agent_id, { type, limit });
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
      to: z.string().optional().describe("ISO date string, defaults to now")
    },
    async ({ agent_id, from, to }) => {
      try {
        const digest = await memoryService.generateDigest(agent_id, { from, to });
        if (!digest) {
          return { content: [{ type: "text", text: "No memories found in that range to summarize" }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(digest) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}

module.exports = { registerTools };
