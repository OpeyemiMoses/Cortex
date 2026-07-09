/**
 * IPFS here is a fast-availability MIRROR, not the source of truth —
 * Arweave is. If Pinata pinning fails or lapses, recall_memory falls back
 * to the Arweave GraphQL lookup (slower, ~1-2s vs ~200ms, but nothing is
 * ever lost). This is why `pin()` failures are logged, not thrown.
 *
 * Uses Pinata's pinJSONToIPFS endpoint (https://docs.pinata.cloud). Any
 * pinning service works the same way — swap the fetch target and auth
 * header if you switch providers.
 */

async function pin(id, payload) {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    console.warn("PINATA_JWT not set — skipping IPFS pin. Arweave remains the source of truth.");
    return { cid: null };
  }

  try {
    const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify({
        pinataContent: payload,
        pinataMetadata: { name: `cortex-memory-${id}` }
      })
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`Pinata pin failed (${res.status}): ${text}`);
      return { cid: null };
    }

    const data = await res.json();
    return { cid: data.IpfsHash };
  } catch (err) {
    console.error("IPFS pin threw, continuing without mirror:", err.message);
    return { cid: null };
  }
}

async function fetchByCid(cid) {
  if (!cid) return null;
  const gateway = process.env.IPFS_GATEWAY_URL || "https://gateway.pinata.cloud/ipfs";

  try {
    const res = await fetch(`${gateway}/${cid}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn(`IPFS gateway fetch failed for ${cid}, will fall back to Arweave:`, err.message);
    return null;
  }
}

module.exports = { pin, fetch: fetchByCid };
