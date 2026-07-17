# Cortex

**A permanent, decentralized memory layer for the AI agent economy.**

Built as an Agent Service Provider (ASP) for the [OKX AI Genesis Hackathon](https://web3.okx.com/xlayer/build-x).

---

## The Problem

AI agents today are functionally amnesiac. Trading bots, autonomous agents,
LangGraph pipelines — they either lose all state the moment they restart,
or depend on a centralized database that can vanish the moment an API key
expires or a company shuts down. There's no way for an agent to prove its
own history is real and hasn't been quietly altered.

## The Solution

Cortex is a memory-as-a-service API that any AI agent can call to
permanently **write**, **recall**, and **query** structured memories.

- Every memory is stored on **Arweave** — paid once, stored permanently,
  independent of whether Cortex itself stays online.
- Every memory is anchored on **X Layer** (OKX's L2) — so its existence and
  integrity can be independently verified by anyone, not just taken on
  Cortex's word.
- Billed **per call** via OKX's **x402** payment protocol — no
  subscriptions, no accounts, fractions of a cent per write.
- Callable over plain **HTTP** or as an **MCP** tool (A2MCP-compatible).

Kill the server. Restart it from zero. Ask for a memory back — it's still
there, because the truth was never sitting in RAM, it was on-chain.

---

## Features

| Feature | Description |
|---|---|
| `write_memory` | Permanently store a memory object (event, decision, outcome, preference, conversation, or digest) |
| `recall_memory` | Retrieve a memory by id, with on-chain verification it hasn't been tampered with |
| `query_memory` | Search an agent's memory history, optionally filtered by type |
| `get_memory_digest` | **Memory Decay** — generate a compressed summary of an agent's history over a time range, without ever touching the raw memories it summarizes |
| Dual interface | Same logic exposed as both a plain REST API and a real MCP server (Streamable HTTP) |
| Pay-per-call | Metered via OKX's Onchain OS Payment SDK (x402) |

---

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js, Express (CommonJS) |
| Validation | Zod |
| Permanent storage | [Arweave](https://arweave.org) via `arweave-js` |
| Fast-availability mirror | IPFS via Pinata (optional — falls back to Arweave if unset) |
| On-chain registry | Solidity contract on **X Layer**, deployed via Hardhat + ethers v6 |
| Payments | OKX Onchain OS Payment SDK — `@okxweb3/x402-express`, `@okxweb3/x402-core`, `@okxweb3/x402-evm` |
| Cache / index | Redis (`redis` npm package) via Upstash — auto-falls back to in-memory if unset |
| Agent interface | `@modelcontextprotocol/sdk` — Streamable HTTP (public) + stdio (local testing) |

---

## Architecture

```
                         ┌─────────────────────┐
   HTTP callers ───────► │   server/index.js    │ ◄─────── A2MCP callers
   (x402-gated)          │   (Express app)       │          (via /mcp)
                         └──────────┬───────────┘
                                    │
                         ┌──────────▼───────────┐
                         │  memoryService.js      │  ← single source of truth
                         │  write / recall /      │    for all business logic
                         │  query / generateDigest│
                         └──┬──────┬──────┬───────┘
                            │      │      │
                 ┌──────────▼┐ ┌───▼────┐ ┌▼─────────────┐
                 │  Arweave   │ │  IPFS  │ │ X Layer       │
                 │  (perm.    │ │ (fast  │ │ on-chain      │
                 │  storage)  │ │ mirror)│ │ registry      │
                 └────────────┘ └────────┘ └───────────────┘
                            │
                     ┌──────▼──────┐
                     │    Redis     │  (index + recall cache)
                     └─────────────┘
```

Both the REST routes (`server/routes/memory.js`) and the MCP tools
(`mcp/tools.js`) are thin wrappers around `memoryService.js` — they can
never drift apart, since there's only one implementation of the actual logic.

---

## API Reference

### Write a memory
```bash
curl -X POST http://localhost:8080/memory/write \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"agent-1","type":"decision","content":"Rebalanced 10% into stables due to volatility spike."}'
```
```json
{
  "memory": {
    "agent_id": "agent-1",
    "type": "decision",
    "content": "Rebalanced 10% into stables due to volatility spike.",
    "id": "34dcd0de...",
    "arweave_tx_id": "boLVAlHE...",
    "onchain_tx_hash": "0x99c445...",
    "written_at": "2026-07-06T03:34:40.110Z"
  }
}
```

### Recall a memory
```bash
curl http://localhost:8080/memory/recall/<id>
```
```json
{
  "memory": { "...": "..." },
  "source": "arweave",
  "verified": true,
  "onchain_anchor": { "agentIdHash": "0x2dff...", "submitter": "0xb482...", "timestamp": 1783468379000 }
}
```

### Query an agent's history
```bash
curl "http://localhost:8080/memory/query?agent_id=agent-1&type=decision&limit=20"
```

### Generate a memory digest (Memory Decay)
```bash
curl "http://localhost:8080/memory/digest?agent_id=agent-1"
```
Compresses an agent's history into a single summary object — itself
written through the exact same pipeline as any other memory, with
`metadata.source_hashes` pointing back to every original it summarizes.
Raw memories are never deleted or altered.

### Core service logic (`server/services/memoryService.js`)
```javascript
async function writeMemory(rawPayload) {
  const payload = MemoryObjectInput.parse(rawPayload);
  const { id, arweave_tx_id, written_at } = await arweave.write(payload);
  const bodyForMirror = { ...payload, id, arweave_tx_id, written_at };
  const { cid } = await ipfs.pin(id, bodyForMirror);
  const { onchain_tx_hash } = await registry.anchor(payload.agent_id, id);
  const record = { ...bodyForMirror, ipfs_cid: cid, onchain_tx_hash };
  await cache.addToIndex(payload.agent_id, id);
  await cache.cacheSet(id, record);
  return record;
}
```

---

## MCP Tools (A2MCP)

Cortex exposes its four tools two ways:

- **`server/mcpHttp.js`** — Streamable HTTP, mounted at `POST /mcp` inside
  the main Express app. **This is the real, publicly-callable interface**
  — the one registered with OKX.AI's A2MCP lane.
- **`mcp/server.js`** — stdio transport, for local testing only with
  MCP-compatible clients (Claude Code, Cursor, etc.). Not reachable over
  the internet.

Both share the exact same tool definitions in `mcp/tools.js`, so what you
test locally matches what's actually deployed.

Test the HTTP endpoint with OKX's recommended tool before registering:
```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP, URL: http://localhost:8080/mcp
```

---

## Getting Started (local development)

```bash
npm install
cp .env.example .env
npm run wallet:generate   # generates an Arweave wallet keyfile
```

### 1. Storage layer — arlocal (free local Arweave devnet)
```bash
npx arlocal
curl http://localhost:1984/mint/<your-arweave-address>/1000000000000
```
`.env.example` defaults to arlocal (`ARWEAVE_HOST=localhost`,
`ARWEAVE_PORT=1984`, `ARWEAVE_PROTOCOL=http`). Switch to
`ARWEAVE_HOST=arweave.net` / port `443` / protocol `https` only once
you're ready to spend real AR.

### 2. On-chain registry — deploy to X Layer testnet
Get free testnet OKB from the [X Layer Faucet](https://www.okx.com/xlayer/faucet/xlayerfaucet), set `REGISTRY_DEPLOYER_PRIVATE_KEY` in `.env`, then:
```bash
npm run registry:compile
npm run registry:deploy:testnet
```
Copy the printed address into `REGISTRY_CONTRACT_ADDRESS`.

### 3. Cache/index — Redis (optional)
Set `REDIS_URL` (e.g. a free Upstash database) if you want the agent
history index and recall cache to survive a restart. Leave blank to use
an automatic in-memory fallback.

### 4. Payments — x402 (optional until you're ready)
Get credentials from the [OKX Developer Portal](https://web3.okx.com/zh-hans/onchainos/dev-portal)
→ `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE`, plus a `PAY_TO_ADDRESS`.
Leave `PAYMENTS_ENFORCED=false` while building; flip to `true` once ready.
Prices are plain USD strings (e.g. `"$0.01"`) — the SDK resolves the
target network's stablecoin automatically, no token address needed.

### 5. Run it
```bash
npm run dev
```

### 6. Run the demo (restart-persistence proof)
```bash
node demo-agent/demoAgent.js write
# copy the printed id, then Ctrl+C the server and `npm run dev` again
node demo-agent/demoAgent.js recall <id>
```
Full shot-by-shot video script in `demo-agent/DEMO_SCRIPT.md`.

---

## Deployment

Deploy `server/index.js` anywhere with a public HTTPS URL (Railway works
well — its default `*.up.railway.app` domain already satisfies A2MCP's
HTTPS requirement, no custom domain needed). Bring your `.env` values with
you as environment variables in your hosting platform.

## Registering as an ASP on OKX.AI

Registration is **conversational**, not a web form. Once deployed:

1. Install Onchain OS Skills and log in to your Agentic Wallet:
   ```
   npx skills add okx/onchainos-skills --yes -g
   ```
2. Prompt an MCP-capable agent (Claude Code, Cline, etc.):
   ```
   Help me register an A2MCP ASP on OKX.AI using Onchain OS
   ```
   You'll be asked for service name, description, price per call, and the
   endpoint — **`https://<your-domain>/mcp`**, specifically the `/mcp`
   path.
3. List it:
   ```
   Help me list my ASP on OKX.AI using Onchain OS
   ```
   Review takes up to 2 business days. Once listed, A2MCP billing is
   handled automatically by OKX.AI.

---

## Project Structure

```
cortex/
├── contracts/
│   └── CortexRegistry.sol        # on-chain anchor/verify contract (X Layer)
├── scripts/
│   └── deployRegistry.js         # hardhat deploy script
├── hardhat.config.js
├── mcp/
│   ├── tools.js                   # tool definitions, shared by both MCP interfaces
│   ├── server.js                  # local stdio MCP server (testing only)
│   └── tool-manifest.json         # reference descriptor
├── demo-agent/
│   ├── demoAgent.js               # restart-persistence proof script
│   └── DEMO_SCRIPT.md             # 90-second video shot list
├── server/
│   ├── index.js                   # Express entrypoint + OKX payment SDK integration
│   ├── mcpHttp.js                 # remote MCP endpoint at /mcp (A2MCP target)
│   ├── routes/memory.js           # thin HTTP transport layer
│   ├── schema/memoryObject.js     # the core data contract
│   ├── utils/hash.js              # canonical content-hash helper
│   └── services/
│       ├── memoryService.js       # shared core logic — single source of truth
│       ├── storage/               # arweaveAdapter, ipfsAdapter
│       │   └── scripts/generateWallet.js
│       ├── registry/              # onchainRegistry
│       └── cache/                 # redisIndex (Redis + in-memory fallback)
├── .env.example
└── package.json
```

---

## Hackathon Submission Checklist

- [x] ASP built with a clear real-world use case
- [ ] Deploy to a public URL
- [ ] Register + list via Onchain OS Skills
- [ ] Submit the Google form before **Jul 17, 2026, 00:00 UTC**
- [ ] Post the ≤90s demo on X with **#okxai**

---

## License

Built for the OKX AI Genesis Hackathon.
