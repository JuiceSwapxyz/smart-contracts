import { ethers, network as hardhatNetwork } from "hardhat";
import { ADDRESS } from "@juicedollar/jusd";
import * as fs from "fs";
import * as path from "path";
import {
  getGasConfig,
  getNetworkConfig,
  getConfirmations,
  formatGasOverrides,
  validateMinimumBalance,
  validateContractDeployed,
} from "./utils/deploy-helpers";

/**
 * Register SUSD (StartUSD) as a bridged token on JuiceSwapGateway
 *
 * This script calls gateway.addBridgedToken(SUSD_ADDRESS, STABLECOIN_BRIDGE_ADDRESS)
 * to enable SUSD → any token swaps through the Gateway.
 *
 * After registration, the Gateway will automatically:
 * - Convert SUSD → JUSD → svJUSD for input tokens
 * - Convert svJUSD → JUSD → SUSD for output tokens
 *
 * This replaces the separate StablecoinBridge routing with unified Gateway routing.
 */
async function main() {
  console.log("========================================");
  console.log("   Register SUSD as Bridged Token      ");
  console.log("========================================\n");

  // ============================================
  // 1. SETUP & VALIDATION
  // ============================================

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkConfig = getNetworkConfig(hardhatNetwork.name);
  const gasConfig = getGasConfig(hardhatNetwork.name);
  const confirmations = getConfirmations(hardhatNetwork.name);

  console.log(`📍 Network: ${networkConfig.name} (Chain ID: ${network.chainId})`);
  console.log(`👤 Signer: ${signer.address}`);
  console.log(`⏳ Confirmations: ${confirmations}`);
  console.log("");

  // ============================================
  // 2. GET ADDRESSES FROM PACKAGES
  // ============================================

  const chainIdNum = Number(network.chainId);

  // Get JuiceDollar addresses
  const juiceDollarAddresses = ADDRESS[chainIdNum];
  if (!juiceDollarAddresses) {
    throw new Error(
      `❌ Chain ${chainIdNum} not supported by @juicedollar/jusd.\n` +
      `   Supported chains: ${Object.keys(ADDRESS).join(", ")}`
    );
  }

  const SUSD_ADDRESS = juiceDollarAddresses.startUSD;
  const BRIDGE_ADDRESS = juiceDollarAddresses.bridgeStartUSD;

  if (!SUSD_ADDRESS) {
    throw new Error(`❌ SUSD (StartUSD) address not defined for chain ${chainIdNum}`);
  }
  if (!BRIDGE_ADDRESS) {
    throw new Error(`❌ StablecoinBridge address not defined for chain ${chainIdNum}`);
  }

  // Get Gateway address from deployment file
  const deploymentPath = path.join(__dirname, "../deployments", networkConfig.folder, "gateway.json");
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(
      `❌ Gateway deployment file not found!\n` +
      `   Expected path: ${deploymentPath}\n` +
      `   Please deploy the Gateway first using deployJuiceSwapGateway.ts`
    );
  }

  const gatewayDeployment = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
  const GATEWAY_ADDRESS = gatewayDeployment.contracts?.JuiceSwapGateway?.address;

  if (!GATEWAY_ADDRESS) {
    throw new Error(`❌ JuiceSwapGateway address not found in deployment file`);
  }

  console.log("📦 Addresses from packages:");
  console.log(`   SUSD (StartUSD):      ${SUSD_ADDRESS}`);
  console.log(`   StablecoinBridge:     ${BRIDGE_ADDRESS}`);
  console.log(`   JuiceSwapGateway:     ${GATEWAY_ADDRESS}`);
  console.log("");

  // ============================================
  // 3. VALIDATE CONTRACTS EXIST
  // ============================================

  console.log("🔍 Validating contracts...");
  await validateContractDeployed(SUSD_ADDRESS, "SUSD");
  console.log(`   ✅ SUSD: ${SUSD_ADDRESS}`);

  await validateContractDeployed(BRIDGE_ADDRESS, "StablecoinBridge");
  console.log(`   ✅ StablecoinBridge: ${BRIDGE_ADDRESS}`);

  await validateContractDeployed(GATEWAY_ADDRESS, "JuiceSwapGateway");
  console.log(`   ✅ JuiceSwapGateway: ${GATEWAY_ADDRESS}`);
  console.log("");

  // ============================================
  // 4. CONNECT TO GATEWAY
  // ============================================

  const gateway = await ethers.getContractAt("IJuiceSwapGateway", GATEWAY_ADDRESS, signer);

  // Check if SUSD is already registered
  const isAlreadyBridged = await gateway.isBridgedToken(SUSD_ADDRESS);
  if (isAlreadyBridged) {
    console.log("✅ SUSD is already registered as a bridged token!");
    console.log("   No action needed.");
    return;
  }

  // ============================================
  // 5. VALIDATE SIGNER IS OWNER
  // ============================================

  // Get owner using Ownable interface
  const gatewayOwnable = await ethers.getContractAt("Ownable", GATEWAY_ADDRESS, signer);
  const owner = await gatewayOwnable.owner();

  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `❌ Signer is not the Gateway owner!\n` +
      `   Signer: ${signer.address}\n` +
      `   Owner:  ${owner}\n` +
      `   Only the owner can register bridged tokens.`
    );
  }

  console.log(`✅ Signer is Gateway owner`);
  console.log("");

  // ============================================
  // 6. ESTIMATE GAS & CHECK BALANCE
  // ============================================

  console.log("💰 Checking balance...");
  const estimatedGas = BigInt(100000); // Conservative estimate for addBridgedToken
  const maxFeePerGas = ethers.parseUnits(gasConfig.maxFeePerGas, "gwei");
  const estimatedCost = estimatedGas * maxFeePerGas;
  await validateMinimumBalance(signer.address, estimatedCost);

  // ============================================
  // 7. REGISTER SUSD AS BRIDGED TOKEN
  // ============================================

  console.log("🚀 Registering SUSD as bridged token...");
  console.log(`   Calling: gateway.addBridgedToken(${SUSD_ADDRESS}, ${BRIDGE_ADDRESS})`);

  const tx = await gateway.addBridgedToken(
    SUSD_ADDRESS,
    BRIDGE_ADDRESS,
    formatGasOverrides(gasConfig, 200000)
  );

  console.log(`   📝 Tx Hash: ${tx.hash}`);
  console.log(`   ⏳ Waiting for ${confirmations} confirmation(s)...`);

  const receipt = await tx.wait(confirmations);

  console.log(`   ✅ Transaction confirmed in block ${receipt?.blockNumber}`);
  console.log("");

  // ============================================
  // 8. VERIFY REGISTRATION
  // ============================================

  console.log("🔍 Verifying registration...");

  const isNowBridged = await gateway.isBridgedToken(SUSD_ADDRESS);
  if (!isNowBridged) {
    throw new Error("❌ Registration verification failed - SUSD is not marked as bridged!");
  }

  const bridgedTokens = await gateway.getBridgedTokens();
  console.log(`   ✅ SUSD is registered as bridged token`);
  console.log(`   📋 All bridged tokens: ${bridgedTokens.join(", ")}`);
  console.log("");

  // Check bridge status
  const bridgeStatus = await gateway.getBridgeStatus(SUSD_ADDRESS);
  console.log("📊 Bridge Status:");
  console.log(`   Can Mint (SUSD → JUSD): ${bridgeStatus.canMint}`);
  console.log(`   Can Burn (JUSD → SUSD): ${bridgeStatus.canBurn}`);
  console.log(`   Mint Capacity: ${ethers.formatEther(bridgeStatus.mintCapacity)} JUSD`);
  console.log(`   Burn Capacity: ${ethers.formatEther(bridgeStatus.burnCapacity)} SUSD`);
  if (bridgeStatus.mintBlockReason) {
    console.log(`   ⚠️  Mint blocked: ${bridgeStatus.mintBlockReason}`);
  }
  if (bridgeStatus.burnBlockReason) {
    console.log(`   ⚠️  Burn blocked: ${bridgeStatus.burnBlockReason}`);
  }
  console.log("");

  // ============================================
  // 9. SUMMARY
  // ============================================

  console.log("========================================");
  console.log("        Registration Complete!         ");
  console.log("========================================\n");

  console.log("📊 Summary:");
  console.log(`   SUSD:              ${SUSD_ADDRESS}`);
  console.log(`   StablecoinBridge:  ${BRIDGE_ADDRESS}`);
  console.log(`   Gateway:           ${GATEWAY_ADDRESS}`);
  console.log(`   Transaction:       ${tx.hash}`);
  console.log("");

  if (networkConfig.explorerUrl) {
    console.log("🔗 Explorer Links:");
    console.log(`   Tx: ${networkConfig.explorerUrl}/tx/${tx.hash}`);
    console.log("");
  }

  console.log("🎉 SUSD is now routed through Gateway!");
  console.log("   Users can now swap SUSD → any token via Gateway.");
  console.log("   Example: SUSD → cBTC (automatically: SUSD → JUSD → svJUSD → cBTC)");
  console.log("");
}

main().catch((error) => {
  console.error("\n❌ Registration failed:", error);
  process.exitCode = 1;
});
