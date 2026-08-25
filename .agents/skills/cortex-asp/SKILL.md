---
name: cortex-asp
description: >
  Cortex Agent Service Provider execution skill. Activates when an A2A
  background sub-session for Agent #4961 (Cortex) receives a system event or
  a2a-agent-chat message for a Write Memory task. Handles the full ASP
  lifecycle: apply → wait for job_accepted → execute memory write via the
  Cortex HTTP API → deliver result.
  Trigger keywords: Cortex, Write Memory, agentId 4961, providerAgentId 4961,
  memoryType, memoryContent, serviceParams, write_memory, recall_memory.
version: "1.0.0"
license: Apache-2.0
---

# Cortex ASP Execution Skill

This skill activates for background Claude sub-sessions running as Agent #4961
(Cortex) on the OKX.AI Task Marketplace. It provides the execution logic for
all Cortex service types.

## When This Skill Activates

You are a **background ASP sub-session** (spawned by `okx-a2a`) when:
- The inbound envelope has `providerAgentId: "4961"` or `agentId: "4961"`
- The task title contains "Write Memory", "Recall Memory", "Query Memory", or "Memory Digest"
- Or you receive an `a2a-agent-chat` message from a User Agent regarding one of these services

Always follow `okx-ai` skill's task-core.md rules for envelope routing and
`next-action` execution. This skill adds the **service-execution layer**.

---

## Service Catalogue

| Service | `serviceParams` keys | Action |
|---|---|---|
| Write Memory | `agentId`, `memoryType`, `memoryContent`, `visibility` | POST `/memory/write` |
| Recall Memory | `memoryId`, `agentId` | GET `/memory/recall/:id` |
| Query Memory | `agentId`, `memoryType`, `limit` | GET `/memory/query` |
| Memory Digest | `agentId`, `from`, `to` | GET `/memory/digest` |

**Cortex API base URL:** `https://cortex-production-9b42.up.railway.app`

> ⚠️ The API is x402-gated. All requests require a valid payment header or
> must come from the A2A payment flow (paymentMode=3 means x402). For
> ASP-internal calls during task execution, use the `--bypass-payment` env
> flag or call the `/memory/*` endpoints directly — the payment was already
> collected on-chain by the task escrow before `job_accepted` was emitted.
> You can call the Cortex API without an x402 payment header by using the
> internal bypass: set `X-A2A-Internal: true` header with the request, or
> use `CALLER_AUTH_ENFORCED=false` (already set on Railway).

---

## Full ASP Execution Flow

### Phase 1 — On `job_created` system event

1. **Do NOT run preflight** — this is a system-event sub-session (skip per task-core.md §Pre-flight).

2. Run `onchainos agent next-action --role auto --agentId 4961 --message '<envelope.message as JSON>'`

3. Execute the returned script exactly. Typically this emits:
   ```bash
   onchainos agent apply --job-id <jobId> --agent-id 4961
   ```
   Run it. After `apply` succeeds, **end the session** — do not attempt to
   deliver yet. Delivery is gated on `job_accepted`.

---

### Phase 2 — On `job_accepted` system event

When a new sub-session starts with `message.event == "job_accepted"`:

1. Parse `serviceParams` from the envelope message. Format:
   ```
   agentId: <value>; memoryType: <value>; memoryContent: <value>; visibility: <value>
   ```

2. Run `onchainos agent next-action --role auto --agentId 4961 --message '<envelope.message as JSON>'`

3. Before executing the `deliver` step from next-action's script, **execute the actual service work**:

#### Write Memory execution:
```bash
curl -s -X POST https://cortex-production-9b42.up.railway.app/memory/write \
  -H "Content-Type: application/json" \
  -H "X-A2A-Internal: true" \
  -d '{
    "agent_id": "<agentId from serviceParams>",
    "type": "<memoryType from serviceParams>",
    "content": "<memoryContent from serviceParams>",
    "visibility": "<visibility from serviceParams>",
    "metadata": {},
    "tags": []
  }'
```

4. Parse the response JSON. On success (`{ "memory": { "id": "...", ... } }`),
   format the deliverable:
   ```json
   {
     "status": "ok",
     "service": "write_memory",
     "result": {
       "id": "<memory.id>",
       "arweave_tx": "<memory.arweave_tx_id>",
       "ipfs_cid": "<memory.ipfs_cid>",
       "onchain_tx": "<memory.onchain_tx_hash>",
       "written_at": "<memory.written_at>",
       "agent_id": "<agentId>",
       "type": "<memoryType>",
       "visibility": "<visibility>"
     }
   }
   ```

5. Run the `deliver` command from next-action's script, passing the formatted
   JSON as `--content`:
   ```bash
   onchainos agent deliver --job-id <jobId> --agent-id 4961 --content '<deliverable JSON>'
   ```

6. After successful deliver, end the session.

---

### Error Handling

- If the Cortex API returns an error (non-2xx or `{ "error": "..." }`):
  - Format the error as the deliverable: `{ "status": "error", "message": "<error>" }`
  - Still run `deliver` with the error content — never leave the task hanging.
  - Log the failure for the human operator.

- If `apply` fails with "already applied" — the session already ran for this
  job. Skip silently and end.

- If `deliver` fails with "status != accepted" — `job_accepted` hasn't arrived
  yet. Do NOT retry; end the session. The daemon will re-dispatch when the
  event arrives.

---

## Important Rules

- 🛑 **Never run `deliver` before `job_accepted`** — the escrow isn't funded.
- 🛑 **Never skip the `curl` service call** before delivering — an empty deliver
  means the user paid but got nothing.
- 🛑 **One `apply` per job** — check next-action output; if it says "nothing
  to do" or "already applied", stop.
- ✅ The `CALLER_AUTH_ENFORCED=false` env var on Railway means you don't need
  to sign write requests — call the API directly.
