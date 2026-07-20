/**
 * The x402 payment middleware verifies the caller's PAYMENT-SIGNATURE header
 * before a protected route is ever reached, but doesn't forward the payer's
 * address to req. Since the same (already-verified) header is still on the
 * request, decode it again here to recover the payer address — no new
 * signature, no marketplace/listing change, just reading what the payment
 * itself already proved.
 *
 * Header value is base64(JSON.stringify(paymentPayload)); for the "exact"
 * EVM scheme, payload.payload.authorization.from is the payer's address.
 */
function extractPayerAddress(req) {
  const header = req.header("payment-signature") || req.header("PAYMENT-SIGNATURE");
  if (!header) return null;

  try {
    const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    const from = payload?.payload?.authorization?.from;
    return typeof from === "string" ? from.toLowerCase() : null;
  } catch {
    return null;
  }
}

module.exports = { extractPayerAddress };
