/**
 * Generates a new Arweave wallet keyfile and saves it to the path in
 * ARWEAVE_WALLET_JSON_PATH. Run once per environment (local dev, staging,
 * production) — never commit the resulting file (see .gitignore).
 *
 * Usage: npm run wallet:generate
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const Arweave = require("arweave");

const arweave = Arweave.init({
  host: process.env.ARWEAVE_HOST || "arweave.net",
  port: process.env.ARWEAVE_PORT || 443,
  protocol: process.env.ARWEAVE_PROTOCOL || "https"
});

(async () => {
  const key = await arweave.wallets.generate();
  const address = await arweave.wallets.jwkToAddress(key);
  const outPath = process.env.ARWEAVE_WALLET_JSON_PATH || "./secrets/arweave-wallet.json";

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(key, null, 2));

  console.log(`New Arweave wallet generated.`);
  console.log(`Address: ${address}`);
  console.log(`Saved to: ${outPath}`);
  console.log();
  console.log(`If ARWEAVE_HOST points at arlocal (local dev), fund it for free:`);
  console.log(`  curl http://localhost:1984/mint/${address}/1000000000000`);
  console.log(`If pointed at arweave.net (mainnet), send real AR to this address before writing.`);
})();
