import { ethers, network as hardhatNetwork } from "hardhat";
import { ADDRESS } from "@juicedollar/jusd";
import { WETH9, CHAIN_TO_ADDRESSES_MAP, ChainId } from "@juiceswapxyz/sdk-core";
import {
  getGasConfig,
  getNetworkConfig,
  getConfirmations,
  formatGasOverrides,
  validateMinimumBalance,
  validateContractsDeployed,
  verifyContract,
  saveDeployment,
  buildDeploymentInfo,
  printDeploymentSummary,
  estimateDeploymentGas,
} from "./utils/deploy-helpers";

/**
 * Deploy JuiceSwapGateway to Citrea network
 *
 * This script:
 * 1. Validates all environment variables and dependency contracts
 * 2. Checks deployer balance
 * 3. Deploys JuiceSwapGateway with proper gas configuration
 * 4. Validates the deployment
 * 5. Saves deployment info to JSON
 * 6. Verifies contract on block explorer
 */
async function main() {
  console.log("========================================");
  console.log("   JuiceSwapGateway Deployment Script  ");
  console.log("========================================\n");

  // ============================================
  // 1. SETUP & VALIDATION
  // ============================================

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkConfig = getNetworkConfig(hardhatNetwork.name);
  const gasConfig = getGasConfig(hardhatNetwork.name);
  const confirmations = getConfirmations(hardhatNetwork.name);

  console.log(`📍 Network: ${networkConfig.name} (Chain ID: ${network.chainId})`);
  console.log(`👤 Deployer: ${deployer.address}`);
  console.log(`⏳ Confirmations: ${confirmations}`);
  console.log("");

  // ============================================
  // Get addresses from canonical packages
  // ============================================
  // Addresses are imported from their source packages:
  // - @juicedollar/jusd: JUSD, svJUSD, JUICE
  // - @juiceswapxyz/sdk-core: WcBTC, SwapRouter, PositionManager

  const chainIdNum = Number(network.chainId);

  // Validate chain is supported by JuiceDollar
  const juiceDollarAddresses = ADDRESS[chainIdNum];
  if (!juiceDollarAddresses) {
    throw new Error(
      `❌ Chain ${chainIdNum} not supported by @juicedollar/jusd.\n` +
      `   Supported chains: ${Object.keys(ADDRESS).join(", ")}`
    );
  }

  // Validate chain is supported by SDK
  // Type assertion needed because CHAIN_TO_ADDRESSES_MAP doesn't include all ChainId values
  const dexAddresses = CHAIN_TO_ADDRESSES_MAP[chainIdNum as keyof typeof CHAIN_TO_ADDRESSES_MAP];
  if (!dexAddresses) {
    throw new Error(
      `❌ Chain ${chainIdNum} not supported by @juiceswapxyz/sdk-core.\n` +
      `   Please ensure the chain is configured in the SDK.`
    );
  }

  // Import addresses from packages (single source of truth)
  const JUSD_ADDRESS = juiceDollarAddresses.juiceDollar;
  const SV_JUSD_ADDRESS = juiceDollarAddresses.savingsVaultJUSD;
  const JUICE_ADDRESS = juiceDollarAddresses.equity;
  const WCBTC_ADDRESS = WETH9[chainIdNum as ChainId]?.address;
  const SWAP_ROUTER_ADDRESS = dexAddresses.swapRouter02Address;
  const POSITION_MANAGER_ADDRESS = dexAddresses.nonfungiblePositionManagerAddress;

  // Validate all addresses are defined
  if (!WCBTC_ADDRESS) {
    throw new Error(`❌ WcBTC (WETH9) not defined for chain ${chainIdNum}`);
  }
  if (!SWAP_ROUTER_ADDRESS) {
    throw new Error(`❌ SwapRouter not defined for chain ${chainIdNum}`);
  }
  if (!POSITION_MANAGER_ADDRESS) {
    throw new Error(`❌ PositionManager not defined for chain ${chainIdNum}`);
  }

  const constructorArgs = [
    JUSD_ADDRESS,
    SV_JUSD_ADDRESS,
    JUICE_ADDRESS,
    WCBTC_ADDRESS,
    SWAP_ROUTER_ADDRESS,
    POSITION_MANAGER_ADDRESS,
  ];

  console.log("📦 Addresses from packages (single source of truth):");
  console.log(`   JUSD:             ${JUSD_ADDRESS} (from @juicedollar/jusd)`);
  console.log(`   svJUSD:           ${SV_JUSD_ADDRESS} (from @juicedollar/jusd)`);
  console.log(`   JUICE:            ${JUICE_ADDRESS} (from @juicedollar/jusd)`);
  console.log(`   WcBTC:            ${WCBTC_ADDRESS} (from @juiceswapxyz/sdk-core)`);
  console.log(`   SwapRouter:       ${SWAP_ROUTER_ADDRESS} (from @juiceswapxyz/sdk-core)`);
  console.log(`   PositionManager:  ${POSITION_MANAGER_ADDRESS} (from @juiceswapxyz/sdk-core)`);
  console.log("");

  // ============================================
  // 2. VALIDATE DEPENDENCY CONTRACTS
  // ============================================

  await validateContractsDeployed([
    { address: JUSD_ADDRESS, name: "JUSD" },
    { address: SV_JUSD_ADDRESS, name: "svJUSD" },
    { address: JUICE_ADDRESS, name: "JUICE" },
    { address: WCBTC_ADDRESS, name: "WcBTC" },
    { address: SWAP_ROUTER_ADDRESS, name: "SwapRouter" },
    { address: POSITION_MANAGER_ADDRESS, name: "PositionManager" },
  ]);

  // ============================================
  // 3. ESTIMATE GAS & VALIDATE BALANCE
  // ============================================

  console.log("💰 Checking deployer balance...");
  const JuiceSwapGateway = await ethers.getContractFactory("JuiceSwapGateway");
  const estimatedCost = await estimateDeploymentGas(JuiceSwapGateway, constructorArgs, gasConfig);
  await validateMinimumBalance(deployer.address, estimatedCost);

  // ============================================
  // 4. DEPLOY CONTRACT
  // ============================================

  console.log("🚀 Deploying JuiceSwapGateway...");
  console.log(`   Gas Config: maxFee=${gasConfig.maxFeePerGas} gwei, priority=${gasConfig.maxPriorityFeePerGas} gwei`);

  const gateway = await JuiceSwapGateway.deploy(
    ...constructorArgs,
    formatGasOverrides(gasConfig, 3000000) // 3M gas limit for safety
  );

  console.log(`   ⏳ Waiting for deployment transaction...`);
  await gateway.waitForDeployment();

  const deploymentTx = gateway.deploymentTransaction();
  console.log(`   📝 Tx Hash: ${deploymentTx?.hash}`);

  console.log(`   ⏳ Waiting for ${confirmations} confirmation(s)...`);
  await deploymentTx?.wait(confirmations);

  const gatewayAddress = await gateway.getAddress();
  printDeploymentSummary("JuiceSwapGateway", gatewayAddress, networkConfig, deploymentTx?.hash);

  // ============================================
  // 5. VALIDATE DEPLOYMENT
  // ============================================

  console.log("\n🔍 Validating deployment...");

  // Note: JuiceSwapGateway is immutable with no owner or pause functionality
  const defaultFee = await gateway.defaultFee();
  const factory = await gateway.FACTORY();

  console.log(`   Default Fee: ${defaultFee} (${defaultFee === 3000n ? "0.3%" : "custom"})`);
  console.log(`   Factory: ${factory}`);
  console.log(`   Note: Contract is immutable (no owner, no pause)`);

  // Validate expected state
  let validationPassed = true;

  if (defaultFee !== 3000n) {
    console.log("   ⚠️  Warning: Default fee is not 3000 (0.3%)!");
    validationPassed = false;
  }

  if (validationPassed) {
    console.log("   ✅ All validations passed!");
  }

  // ============================================
  // 6. SAVE DEPLOYMENT FILE
  // ============================================

  const blockNumber = await ethers.provider.getBlockNumber();

  const deploymentInfo = buildDeploymentInfo({
    networkName: networkConfig.name,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    blockNumber,
    contracts: {
      JuiceSwapGateway: {
        address: gatewayAddress,
        deploymentTx: deploymentTx?.hash,
        constructorArgs,
      },
    },
    references: {
      jusdAddress: JUSD_ADDRESS,
      svJusdAddress: SV_JUSD_ADDRESS,
      juiceAddress: JUICE_ADDRESS,
      wcbtcAddress: WCBTC_ADDRESS,
      swapRouterAddress: SWAP_ROUTER_ADDRESS,
      positionManagerAddress: POSITION_MANAGER_ADDRESS,
    },
    scriptVersion: "2.0.0",
  });

  console.log("");
  saveDeployment(networkConfig.folder, "gateway.json", deploymentInfo);

  // ============================================
  // 7. VERIFY CONTRACT
  // ============================================

  const verified = await verifyContract(
    gatewayAddress,
    constructorArgs,
    "contracts/JuiceSwapGateway.sol:JuiceSwapGateway"
  );

  // ============================================
  // 8. SUMMARY
  // ============================================

  console.log("\n========================================");
  console.log("        Deployment Complete!           ");
  console.log("========================================\n");

  console.log("📊 Summary:");
  console.log(`   Contract: JuiceSwapGateway`);
  console.log(`   Address:  ${gatewayAddress}`);
  console.log(`   Network:  ${networkConfig.name}`);
  console.log(`   Verified: ${verified ? "Yes" : "No (see manual command above)"}`);
  console.log("");

  if (networkConfig.explorerUrl) {
    console.log("🔗 Explorer Links:");
    console.log(`   ${networkConfig.explorerUrl}/address/${gatewayAddress}`);
    console.log("");
  }

  console.log("📘 Next Steps:");
  console.log("   1. Add gateway address to @juiceswapxyz/sdk-core package");
  console.log("   2. Publish updated sdk-core and update dependent packages");
  console.log("   3. Test gateway functions (swaps, LP operations)");
  if (!verified) {
    console.log("   4. Manually verify contract if auto-verification failed");
  }
  console.log("");
  console.log("📋 Gateway Address: " + gatewayAddress);
  console.log("");
}

main().catch((error) => {
  console.error("\n❌ Deployment failed:", error);
  process.exitCode = 1;
});
