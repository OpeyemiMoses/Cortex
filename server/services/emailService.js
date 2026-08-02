const { Resend } = require("resend");

/**
 * Sends a one-time email notification summarizing a newly stored memory.
 * Uses Resend SDK and sends from onboarding@resend.dev.
 *
 * @param {object} params
 * @param {string} params.email - Recipient email address
 * @param {object} params.memoryRecord - Stored memory object (id, agent_id, type, content, written_at, arweave_tx_id, onchain_tx_hash)
 * @param {string|null} [params.x402TxHash] - x402 payment transaction hash if available
 * @param {string|null} [params.x402Link] - X Layer explorer link for x402 payment
 * @param {string|null} [params.anchoredLink] - X Layer explorer link for anchored transaction
 */
async function sendMemoryNotification({ email, memoryRecord, x402TxHash, x402Link, anchoredLink }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[emailService] RESEND_API_KEY is not set. Skipping email notification.");
    return { sent: false, reason: "missing_api_key" };
  }

  if (!email || typeof email !== "string") {
    console.warn("[emailService] Invalid recipient email address provided.");
    return { sent: false, reason: "invalid_email" };
  }

  const resend = new Resend(apiKey);

  const {
    id = "",
    agent_id = "",
    type = "",
    content = "",
    written_at = new Date().toISOString(),
    arweave_tx_id = null,
    onchain_tx_hash = null
  } = memoryRecord || {};

  const arweaveUrl = arweave_tx_id ? `https://arweave.net/${arweave_tx_id}` : null;
  const shortId = id ? `${id.slice(0, 12)}...` : "Memory";

  const textContent = `
Cortex Memory Storage Notification
----------------------------------
Memory ID:      ${id}
Agent ID:       ${agent_id}
Memory Type:    ${type}
Timestamp:      ${written_at}

Content:
${content}

Permanent Storage (Arweave):
  TX ID: ${arweave_tx_id || "N/A"}
  URL:   ${arweaveUrl || "N/A"}

On-Chain Proof (X Layer):
  Anchored Hash: ${onchain_tx_hash || "N/A"}
  Anchored Link: ${anchoredLink || "N/A"}
  x402 Tx Hash:  ${x402TxHash || "N/A"}
  x402 Tx Link:  ${x402Link || "N/A"}
`.trim();

  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }
    .container { max-width: 600px; margin: 0 auto; background: #1e293b; border-radius: 12px; padding: 32px; border: 1px solid #334155; }
    h2 { color: #38bdf8; margin-top: 0; font-size: 22px; }
    .badge { display: inline-block; background: #0284c7; color: #ffffff; font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 9999px; text-transform: uppercase; margin-bottom: 16px; }
    .field { margin-bottom: 16px; }
    .label { font-size: 12px; font-weight: 600; text-transform: uppercase; color: #94a3b8; margin-bottom: 4px; }
    .value { font-size: 14px; color: #f1f5f9; word-break: break-all; font-family: monospace; background: #0f172a; padding: 8px 12px; border-radius: 6px; border: 1px solid #334155; }
    .content-box { font-family: inherit; white-space: pre-wrap; font-size: 14px; line-height: 1.6; background: #0f172a; padding: 12px; border-radius: 6px; border: 1px solid #334155; color: #e2e8f0; }
    a { color: #38bdf8; text-decoration: none; word-break: break-all; }
    a:hover { text-decoration: underline; }
    .footer { margin-top: 24px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #334155; padding-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <h2>Cortex Memory Storage Notification</h2>
    <span class="badge">${type}</span>

    <div class="field">
      <div class="label">Memory ID</div>
      <div class="value">${id}</div>
    </div>

    <div class="field">
      <div class="label">Agent ID</div>
      <div class="value">${agent_id}</div>
    </div>

    <div class="field">
      <div class="label">Timestamp</div>
      <div class="value">${written_at}</div>
    </div>

    <div class="field">
      <div class="label">Content</div>
      <div class="content-box">${escapeHtml(content)}</div>
    </div>

    <div class="field">
      <div class="label">Permanent Storage (Arweave)</div>
      <div class="value">
        TX ID: ${arweave_tx_id || "N/A"}<br/>
        ${arweaveUrl ? `<a href="${arweaveUrl}" target="_blank">View on Arweave Gateway &rarr;</a>` : ""}
      </div>
    </div>

    <div class="field">
      <div class="label">On-Chain Anchored Verification (X Layer)</div>
      <div class="value">
        Hash: ${onchain_tx_hash || "N/A"}<br/>
        ${anchoredLink ? `<a href="${anchoredLink}" target="_blank">View Anchored Transaction on X Layer &rarr;</a>` : ""}
      </div>
    </div>

    ${
      x402Link || x402TxHash
        ? `
    <div class="field">
      <div class="label">x402 Payment Transaction (X Layer)</div>
      <div class="value">
        ${x402TxHash ? `Hash: ${x402TxHash}<br/>` : ""}
        ${x402Link ? `<a href="${x402Link}" target="_blank">View x402 Payment Transaction on X Layer &rarr;</a>` : ""}
      </div>
    </div>
    `
        : ""
    }

    <div class="footer">
      This is an automated delivery confirmation from Cortex Memory Service.
    </div>
  </div>
</body>
</html>
`.trim();

  try {
    const { data, error } = await resend.emails.send({
      from: "Cortex Memory <onboarding@resend.dev>",
      to: [email],
      subject: `[Cortex] Memory Stored (${shortId})`,
      text: textContent,
      html: htmlContent
    });

    if (error) {
      console.error("[emailService] Resend API error:", error.message || error);
      return { sent: false, error: error.message || error };
    }

    console.log(`[emailService] Email notification successfully sent to ${email} (email_id: ${data?.id})`);
    return { sent: true, id: data?.id };
  } catch (err) {
    console.error("[emailService] Exception sending email:", err.message || err);
    return { sent: false, error: err.message || err };
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

module.exports = { sendMemoryNotification };
