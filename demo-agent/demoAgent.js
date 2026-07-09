/**
 * Demo agent for the 90-second submission video. The whole point is to
 * prove memory survives a REAL process restart — not a cache trick.
 *
 * Usage:
 *   1. Start Cortex in one terminal:        npm run dev
 *   2. In another terminal, write a memory: node demo-agent/demoAgent.js write
 *      -> copy the printed id
 *   3. Go back to the Cortex terminal, Ctrl+C to kill it, then: npm run dev
 *      (this is a genuine process restart — say so on camera)
 *   4. Recall it: node demo-agent/demoAgent.js recall <id-from-step-2>
 *      -> still returns the memory, verified on-chain
 *
 * Why this is a fair test, not a trick: recall_memory's lookup path
 * (server/services/storage/arweaveAdapter.js -> read()) queries Arweave's
 * public GraphQL endpoint by content-hash tag — it does not depend on
 * anything held in the Cortex process's memory. That's what "permanent"
 * actually means here.
 *
 * Note: this specifically tests recall_memory, not query_memory. Listing
 * an agent's full history via query_memory currently depends on the
 * index (Redis, or its in-memory fallback) — set REDIS_URL if you want
 * that to survive restarts too; recall-by-id doesn't need it.
 */

const BASE_URL = process.env.CORTEX_URL || "http://localhost:8080";
const AGENT_ID = "demo-trading-agent";

async function writeDemoMemory() {
  console.log(`[demo-agent] Writing a decision memory as "${AGENT_ID}"...`);

  const res = await fetch(`${BASE_URL}/memory/write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_id: AGENT_ID,
      type: "decision",
      content: "Rebalanced 10% of portfolio into stablecoins due to a volatility spike in BTC.",
      metadata: { volatility_index: 0.82, action: "rebalance", pct: 10 }
    })
  });

  const data = await res.json();
  if (!res.ok) {
    console.error("[demo-agent] Write failed:", data);
    process.exit(1);
  }

  console.log(`[demo-agent] Memory written.`);
  console.log(`  id              = ${data.memory.id}`);
  console.log(`  arweave_tx_id   = ${data.memory.arweave_tx_id}`);
  console.log(`  onchain_tx_hash = ${data.memory.onchain_tx_hash}`);
  console.log();
  console.log(`Now: Ctrl+C the Cortex server, restart it (npm run dev), then run:`);
  console.log(`  node demo-agent/demoAgent.js recall ${data.memory.id}`);
}

async function recallDemoMemory(id) {
  if (!id) {
    console.error("Usage: node demo-agent/demoAgent.js recall <id>");
    process.exit(1);
  }

  console.log(`[demo-agent] Recalling memory ${id} after restart...`);

  const res = await fetch(`${BASE_URL}/memory/recall/${id}`);
  const data = await res.json();

  if (!res.ok) {
    console.error("[demo-agent] Recall failed — memory not found:", data);
    process.exit(1);
  }

  console.log(`[demo-agent] Recalled successfully.`);
  console.log(`  source          = ${data.source}`);
  console.log(`  onchain verified = ${data.verified}`);
  console.log(`  content         = "${data.memory.content}"`);
  console.log();
  console.log(`This process just started — that memory was never in its RAM.`);
  console.log(`It came back from Arweave, verified against the X Layer registry.`);
}

const [, , command, arg] = process.argv;

if (command === "write") writeDemoMemory();
else if (command === "recall") recallDemoMemory(arg);
else {
  console.log("Usage:");
  console.log("  node demo-agent/demoAgent.js write");
  console.log("  node demo-agent/demoAgent.js recall <id>");
}
