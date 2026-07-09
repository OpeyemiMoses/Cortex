const hre = require("hardhat");

async function main() {
  const signers = await hre.ethers.getSigners();
  if (signers.length === 0) {
    throw new Error(
      "No signer available for this network — REGISTRY_DEPLOYER_PRIVATE_KEY is missing, " +
      "empty, or malformed in your .env file. It must be a 64-character hex string, " +
      "with or without a 0x prefix (e.g. REGISTRY_DEPLOYER_PRIVATE_KEY=0xabc123...), " +
      "no quotes. Double-check .env and try again."
    );
  }

  const CortexRegistry = await hre.ethers.getContractFactory("CortexRegistry");
  const registry = await CortexRegistry.deploy();
  await registry.waitForDeployment();

  const address = await registry.getAddress();
  console.log(`CortexRegistry deployed to: ${address}`);
  console.log(`Network: ${hre.network.name}`);
  console.log();
  console.log(`Add this to your .env:`);
  console.log(`REGISTRY_CONTRACT_ADDRESS=${address}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
