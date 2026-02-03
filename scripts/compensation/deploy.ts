/**
 * Deployment Script for CompensationClaim Contract
 *
 * Deploys the CompensationClaim contract to Citrea Mainnet.
 *
 * Prerequisites:
 * 1. Generate merkle tree: npx ts-node scripts/compensation/generateMerkleTree.ts
 * 2. Set DEPLOYER_PRIVATE_KEY in .env
 * 3. Ensure deployer has cBTC for gas
 *
 * Usage:
 *   npx hardhat run scripts/compensation/deploy.ts --network citrea
 *
 * Test with fork:
 *   FORK_MAINNET=true npx hardhat run scripts/compensation/deploy.ts --network hardhat
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// Token addresses on Citrea Mainnet (Chain ID: 4114)
const JUSD_ADDRESS = "0x0987D3720D38847ac6dBB9D025B9dE892a3CA35C";
const TAPFREAK_ADDRESS = "0xFAEd2b431304426f9320761AfDc698463b6FD8C7";

// Claim amounts (10 tokens each, 18 decimals)
const JUSD_AMOUNT_PER_CLAIM = ethers.parseEther("10");
const TAPFREAK_AMOUNT_PER_CLAIM = ethers.parseEther("10");

// Claim deadline (30 days from deployment, or 0 for no deadline)
const CLAIM_DEADLINE_DAYS = 30;

interface DeploymentResult {
  contractAddress: string;
  merkleRoot: string;
  jusdAddress: string;
  tapfreakAddress: string;
  jusdAmountPerClaim: string;
  tapfreakAmountPerClaim: string;
  claimDeadline: string;
  totalEligibleAddresses: number;
  totalJusdRequired: string;
  totalTapfreakRequired: string;
  deployedAt: string;
  deployer: string;
  chainId: number;
  txHash: string;
}

async function main() {
  console.log("=".repeat(60));
  console.log("CompensationClaim Contract Deployment");
  console.log("=".repeat(60));

  // Get signer
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log(`\nNetwork: ${network.name} (Chain ID: ${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance: ${ethers.formatEther(balance)} cBTC`);

  // Validate network
  if (network.chainId !== 4114n && network.chainId !== 31337n) {
    console.error("\nError: This script is intended for Citrea Mainnet (4114) or local fork (31337)");
    console.log("Current chain ID:", network.chainId);
    process.exit(1);
  }

  // Load merkle root
  const merkleRootPath = path.join(__dirname, "../../data/compensation/merkle-root.json");
  if (!fs.existsSync(merkleRootPath)) {
    console.error("\nError: Merkle root not found. Run generateMerkleTree.ts first.");
    console.log("Expected path:", merkleRootPath);
    process.exit(1);
  }

  const merkleData = JSON.parse(fs.readFileSync(merkleRootPath, "utf-8"));
  const merkleRoot = merkleData.root;
  const totalAddresses = merkleData.totalAddresses;

  console.log(`\nMerkle Root: ${merkleRoot}`);
  console.log(`Total Eligible Addresses: ${totalAddresses}`);

  // Calculate totals
  const totalJusdRequired = JUSD_AMOUNT_PER_CLAIM * BigInt(totalAddresses);
  const totalTapfreakRequired = TAPFREAK_AMOUNT_PER_CLAIM * BigInt(totalAddresses);

  console.log(`\nTokens Required:`);
  console.log(`  JUSD: ${ethers.formatEther(totalJusdRequired)} (${totalAddresses} x 10)`);
  console.log(`  TAPFREAK: ${ethers.formatEther(totalTapfreakRequired)} (${totalAddresses} x 10)`);

  // Calculate deadline
  const claimDeadline =
    CLAIM_DEADLINE_DAYS > 0 ? Math.floor(Date.now() / 1000) + CLAIM_DEADLINE_DAYS * 24 * 60 * 60 : 0;

  if (claimDeadline > 0) {
    const deadlineDate = new Date(claimDeadline * 1000);
    console.log(`\nClaim Deadline: ${deadlineDate.toISOString()} (${CLAIM_DEADLINE_DAYS} days)`);
  } else {
    console.log(`\nClaim Deadline: None`);
  }

  console.log("\n" + "-".repeat(60));
  console.log("Deployment Parameters:");
  console.log("-".repeat(60));
  console.log(`  JUSD Address: ${JUSD_ADDRESS}`);
  console.log(`  TAPFREAK Address: ${TAPFREAK_ADDRESS}`);
  console.log(`  JUSD per claim: ${ethers.formatEther(JUSD_AMOUNT_PER_CLAIM)}`);
  console.log(`  TAPFREAK per claim: ${ethers.formatEther(TAPFREAK_AMOUNT_PER_CLAIM)}`);
  console.log("-".repeat(60));

  // Deploy contract
  console.log("\nDeploying CompensationClaim...");

  const CompensationClaim = await ethers.getContractFactory("CompensationClaim");
  const contract = await CompensationClaim.deploy(
    JUSD_ADDRESS,
    TAPFREAK_ADDRESS,
    merkleRoot,
    JUSD_AMOUNT_PER_CLAIM,
    TAPFREAK_AMOUNT_PER_CLAIM,
    claimDeadline
  );

  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();
  const deployTx = contract.deploymentTransaction();

  console.log(`\nContract deployed!`);
  console.log(`  Address: ${contractAddress}`);
  console.log(`  TX Hash: ${deployTx?.hash}`);

  // Verify deployment
  console.log("\nVerifying deployment...");
  const deployedMerkleRoot = await contract.merkleRoot();
  const deployedJusdAmount = await contract.jusdAmountPerClaim();
  const deployedTapfreakAmount = await contract.tapfreakAmountPerClaim();

  if (deployedMerkleRoot !== merkleRoot) {
    console.error("ERROR: Merkle root mismatch!");
  }
  if (deployedJusdAmount !== JUSD_AMOUNT_PER_CLAIM) {
    console.error("ERROR: JUSD amount mismatch!");
  }
  if (deployedTapfreakAmount !== TAPFREAK_AMOUNT_PER_CLAIM) {
    console.error("ERROR: TAPFREAK amount mismatch!");
  }

  console.log("Verification passed!");

  // Save deployment info
  const deploymentResult: DeploymentResult = {
    contractAddress,
    merkleRoot,
    jusdAddress: JUSD_ADDRESS,
    tapfreakAddress: TAPFREAK_ADDRESS,
    jusdAmountPerClaim: ethers.formatEther(JUSD_AMOUNT_PER_CLAIM),
    tapfreakAmountPerClaim: ethers.formatEther(TAPFREAK_AMOUNT_PER_CLAIM),
    claimDeadline: claimDeadline > 0 ? new Date(claimDeadline * 1000).toISOString() : "none",
    totalEligibleAddresses: totalAddresses,
    totalJusdRequired: ethers.formatEther(totalJusdRequired),
    totalTapfreakRequired: ethers.formatEther(totalTapfreakRequired),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    chainId: Number(network.chainId),
    txHash: deployTx?.hash || "",
  };

  // Ensure deployments directory exists
  const deploymentsDir = path.join(__dirname, "../../deployments/mainnet");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const deploymentPath = path.join(deploymentsDir, "compensation-claim.json");
  fs.writeFileSync(deploymentPath, JSON.stringify(deploymentResult, null, 2));
  console.log(`\nDeployment info saved to: ${deploymentPath}`);

  // Print next steps
  console.log("\n" + "=".repeat(60));
  console.log("NEXT STEPS");
  console.log("=".repeat(60));
  console.log(`
1. Transfer tokens to the contract:
   - JUSD: ${ethers.formatEther(totalJusdRequired)} to ${contractAddress}
   - TAPFREAK: ${ethers.formatEther(totalTapfreakRequired)} to ${contractAddress}

2. Verify contract on explorer (optional):
   npx hardhat verify --network citrea ${contractAddress} \\
     "${JUSD_ADDRESS}" \\
     "${TAPFREAK_ADDRESS}" \\
     "${merkleRoot}" \\
     "${JUSD_AMOUNT_PER_CLAIM}" \\
     "${TAPFREAK_AMOUNT_PER_CLAIM}" \\
     "${claimDeadline}"

3. Share merkle-proofs.json with the frontend team

4. Announce the claim to affected users
`);

  return deploymentResult;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
