# 90-Second Demo Video — Shot List

Target: ≤90 seconds, posted to X with #okxai, explaining what Cortex does
and the problem it solves (per hackathon submission requirements).

| Time | Shot | What to say / show |
|---|---|---|
| 0:00–0:10 | Talking head or text card | "Every AI agent forgets everything the moment it restarts. Cortex fixes that." |
| 0:10–0:25 | Terminal: `node demo-agent/demoAgent.js write` | Show the printed `id`, `arweave_tx_id`, `onchain_tx_hash`. "This memory is now permanently stored on Arweave and anchored on X Layer." |
| 0:25–0:35 | Terminal: Ctrl+C the running Cortex server | "I'm killing the server. Not clearing a cache — killing the whole process." |
| 0:35–0:45 | Terminal: `npm run dev` (fresh start) | "Restarting from scratch. No memory of anything that just happened." |
| 0:45–0:60 | Terminal: `node demo-agent/demoAgent.js recall <id>` | Show `verified: true` and the original content coming back. "It remembers — because the truth was never in the server, it's on-chain." |
| 0:60–0:75 | (Optional, strong visual) X Layer explorer showing the anchor transaction | "Anyone can verify this independently — not just take Cortex's word for it." |
| 0:75–0:90 | Text card / talking head | "Cortex — permanent memory for the AI agent economy. Callable by any agent, pay-per-use, on OKX.AI. #okxai" |

## Notes for recording
- Do the actual restart on camera — the whole pitch depends on it being visibly a real process kill, not a trick cut.
- Have `X402_PRICE_WRITE_MEMORY_USDC` etc. visible somewhere (e.g. a quick `.env` glance) if you want to gesture at the pay-per-call model without spending the time explaining x402 in full.
- If `PAYMENTS_ENFORCED=false` for the demo (likely, given the facilitator URL/asset address still need confirming — see main README), say "payments are wired but not enforced in this demo" rather than implying it's live — keeps the claim honest.
