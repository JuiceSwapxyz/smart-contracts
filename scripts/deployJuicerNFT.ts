import { ethers, network, run } from "hardhat";
import "dotenv/config";

/**
 * Deploy JuicerNFT.sol — the signature-claimed Juicer loyalty NFT.
 *
 * All product parameters come from env so a deployment needs no code change:
 *
 *   JUICER_SIGNER_ADDRESS   (required) — backend signer. MUST equal the
 *                           address of JUICER_SIGNER_PRIVATE_KEY in the api
 *                           repo, or every claim() reverts with InvalidSignature.
 *   JUICER_BASE_TOKEN_URI   (required) — IPFS base URI for metadata
 *                           (e.g. "ipfs://<CID>/").
 *   JUICER_CAMPAIGN_START   (optional) — unix seconds; default = now.
 *   JUICER_CAMPAIGN_END     (required) — unix seconds; must be > start and now.
 *   JUICER_MAX_SUPPLY       (required) — hard cap, > 0.
 *   DEPLOYER_PRIVATE_KEY    (required for live networks) — funded deployer.
 *
 * Usage:
 *   npx hardhat run scripts/deployJuicerNFT.ts --network citreaTestnet
 *   npx hardhat run scripts/deployJuicerNFT.ts --network citrea
 *
 * After deploy, wire the printed address into:
 *   - api  .env: JUICER_NFT_CONTRACT_MAINNET / _TESTNET
 *   - bapp juicerCampaign service contract constant
 * and confirm the on-chain `signer` matches the api signer (printed below).
 */

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v.trim();
}

function optionalIntEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer (got "${v}")`);
  }
  return n;
}

async function main(): Promise<void> {
  const signerAddress = requireEnv("JUICER_SIGNER_ADDRESS");
  if (!ethers.isAddress(signerAddress)) {
    throw new Error(`JUICER_SIGNER_ADDRESS is not a valid address: ${signerAddress}`);
  }
  const baseTokenURI = requireEnv("JUICER_BASE_TOKEN_URI");
  const nowSec = Math.floor(Date.now() / 1000);
  const campaignStart = optionalIntEnv("JUICER_CAMPAIGN_START", nowSec);
  const campaignEnd = Number(requireEnv("JUICER_CAMPAIGN_END"));
  const maxSupply = Number(requireEnv("JUICER_MAX_SUPPLY"));

  // Mirror the constructor's require() checks so misconfig fails locally,
  // before spending gas on a guaranteed revert.
  if (!Number.isInteger(campaignEnd) || campaignEnd <= campaignStart) {
    throw new Error("JUICER_CAMPAIGN_END must be an integer greater than the start");
  }
  if (campaignEnd <= nowSec) {
    throw new Error("JUICER_CAMPAIGN_END must be in the future");
  }
  if (!Number.isInteger(maxSupply) || maxSupply <= 0) {
    throw new Error("JUICER_MAX_SUPPLY must be a positive integer");
  }

  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("=== JuicerNFT deployment ===");
  console.log("Network:        ", network.name);
  console.log("Deployer:       ", deployer.address);
  console.log("Deployer balance:", ethers.formatEther(balance), "cBTC");
  console.log("Signer:         ", signerAddress);
  console.log("Base token URI: ", baseTokenURI);
  console.log("Campaign start: ", campaignStart, `(${new Date(campaignStart * 1000).toISOString()})`);
  console.log("Campaign end:   ", campaignEnd, `(${new Date(campaignEnd * 1000).toISOString()})`);
  console.log("Max supply:     ", maxSupply);

  const JuicerNFT = await ethers.getContractFactory("JuicerNFT");
  const contract = await JuicerNFT.deploy(
    signerAddress,
    baseTokenURI,
    campaignStart,
    campaignEnd,
    maxSupply,
  );
  await contract.waitForDeployment();

  const deployedAddress = await contract.getAddress();
  console.log("\n✅ JuicerNFT deployed at:", deployedAddress);

  // Sanity: read back the configured signer so the operator can confirm it
  // matches the api signer before any user tries to claim. (`signer` collides
  // with ethers' Contract.signer property, so go through `functions`.)
  const onChainSigner: string = await contract.getFunction("signer")();
  console.log("On-chain signer:", onChainSigner);
  if (onChainSigner.toLowerCase() !== signerAddress.toLowerCase()) {
    console.warn("⚠️  On-chain signer does not match JUICER_SIGNER_ADDRESS!");
  }

  console.log("\nNext steps:");
  console.log(
    `  api  .env -> JUICER_NFT_CONTRACT_${network.name === "citreaTestnet" ? "TESTNET" : "MAINNET"}=${deployedAddress}`,
  );
  console.log("  bapp -> set the JuicerNFT contract address in the juicerCampaign service");
  console.log("  api  -> JUICER_SIGNER_PRIVATE_KEY must be the key for", signerAddress);

  // Best-effort verification on live networks.
  if (network.name === "citrea" || network.name === "citreaTestnet") {
    console.log("\nWaiting for confirmations before verification...");
    await contract.deploymentTransaction()?.wait(5);
    try {
      await run("verify:verify", {
        address: deployedAddress,
        constructorArguments: [
          signerAddress,
          baseTokenURI,
          campaignStart,
          campaignEnd,
          maxSupply,
        ],
      });
      console.log("✅ Verified on block explorer");
    } catch (err: any) {
      console.warn("Verification skipped/failed:", err.message);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
