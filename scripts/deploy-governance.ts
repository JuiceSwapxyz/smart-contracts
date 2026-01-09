import { ethers, network as hardhatNetwork } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { ADDRESS } from "@juicedollar/jusd";
import { V3_CORE_FACTORY_ADDRESSES, CHAIN_TO_ADDRESSES_MAP } from "@juiceswapxyz/sdk-core";
import {
  getGasConfig,
  getNetworkConfig,
  getConfirmations,
  formatGasOverrides,
  validateMinimumBalance,
  validateContractDeployed,
  verifyContract,
  printDeploymentSummary,
} from "./utils/deploy-helpers";

/**
 * Deploy JuiceSwapGovernor and JuiceSwapFeeCollector, then transfer
 * ownership of Factory and ProxyAdmin to the Governor.
 *
 * This script:
 * 1. Gets addresses from canonical packages (@juicedollar/jusd, @juiceswapxyz/sdk-core)
 * 2. Validates PROXY_ADMIN_ADDRESS from .env (governance-specific)
 * 3. Checks deployer balance
 * 4. Deploys JuiceSwapGovernor
 * 5. Deploys JuiceSwapFeeCollector (owned by Governor)
 * 6. Transfers Factory ownership to Governor
 * 7. Transfers ProxyAdmin ownership to Governor
 * 8. Saves deployment info to JSON
 * 9. Verifies both contracts on block explorer
 */

// Only PROXY_ADMIN_ADDRESS remains in .env (governance-specific, not in packages)
if (!process.env.PROXY_ADMIN_ADDRESS) {
  throw new Error(
    "Missing required environment variable: PROXY_ADMIN_ADDRESS\n\n" +
    "This is the only address that must be set in .env.\n" +
    "All other addresses are imported from packages."
  );
}

const PROXY_ADMIN_ADDRESS = process.env.PROXY_ADMIN_ADDRESS;

async function main() {
  console.log("========================================");
  console.log("   JuiceSwap Governance Deployment     ");
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
      `❌ Chain ${chainIdNum} not supported by @juiceswapxyz/sdk-core.`
    );
  }

  // Import addresses from packages (single source of truth)
  const JUSD_ADDRESS = juiceDollarAddresses.juiceDollar;
  const JUICE_ADDRESS = juiceDollarAddresses.equity;
  const FACTORY_ADDRESS = V3_CORE_FACTORY_ADDRESSES[chainIdNum as keyof typeof V3_CORE_FACTORY_ADDRESSES];
  const SWAP_ROUTER_ADDRESS = dexAddresses.swapRouter02Address;

  // Validate all addresses are defined
  if (!FACTORY_ADDRESS) {
    throw new Error(`❌ Factory not defined for chain ${chainIdNum}`);
  }
  if (!SWAP_ROUTER_ADDRESS) {
    throw new Error(`❌ SwapRouter not defined for chain ${chainIdNum}`);
  }

  console.log("📦 Addresses from packages (single source of truth):");
  console.log(`   JUSD:        ${JUSD_ADDRESS} (from @juicedollar/jusd)`);
  console.log(`   JUICE:       ${JUICE_ADDRESS} (from @juicedollar/jusd)`);
  console.log(`   Factory:     ${FACTORY_ADDRESS} (from @juiceswapxyz/sdk-core)`);
  console.log(`   SwapRouter:  ${SWAP_ROUTER_ADDRESS} (from @juiceswapxyz/sdk-core)`);
  console.log("");

  console.log("📋 From .env (governance-specific):");
  console.log(`   ProxyAdmin:  ${PROXY_ADMIN_ADDRESS}`);
  console.log("");

  // ============================================
  // 2. VALIDATE DEPENDENCY CONTRACTS
  // ============================================

  console.log("🔍 Validating dependency contracts...");

  await validateContractDeployed(JUSD_ADDRESS, "JUSD");
  console.log(`   ✅ JUSD: ${JUSD_ADDRESS}`);

  await validateContractDeployed(JUICE_ADDRESS, "JUICE");
  console.log(`   ✅ JUICE: ${JUICE_ADDRESS}`);

  await validateContractDeployed(FACTORY_ADDRESS, "Factory");
  console.log(`   ✅ Factory: ${FACTORY_ADDRESS}`);

  await validateContractDeployed(SWAP_ROUTER_ADDRESS, "SwapRouter");
  console.log(`   ✅ SwapRouter: ${SWAP_ROUTER_ADDRESS}`);

  await validateContractDeployed(PROXY_ADMIN_ADDRESS, "ProxyAdmin");
  console.log(`   ✅ ProxyAdmin: ${PROXY_ADMIN_ADDRESS}`);
  console.log("");

  // ============================================
  // 3. ESTIMATE GAS & VALIDATE BALANCE
  // ============================================

  console.log("💰 Checking deployer balance...");

  // Estimate gas for both deployments + ownership transfers
  // Governor: ~1.5M gas, FeeCollector: ~2.5M gas, transfers: ~0.2M each
  const estimatedTotalGas = 5000000n; // 5M gas total estimate
  const maxFeePerGas = ethers.parseUnits(gasConfig.maxFeePerGas, "gwei");
  const estimatedCost = estimatedTotalGas * maxFeePerGas;

  await validateMinimumBalance(deployer.address, estimatedCost);

  // ============================================
  // 4. DEPLOY JUICESWAP GOVERNOR
  // ============================================

  console.log("📝 Step 1: Deploying JuiceSwapGovernor...");

  const JuiceSwapGovernorFactory = await ethers.getContractFactory("JuiceSwapGovernor");
  const governorArgs = [JUSD_ADDRESS, JUICE_ADDRESS];

  const governor = await JuiceSwapGovernorFactory.deploy(
    ...governorArgs,
    formatGasOverrides(gasConfig, 2000000)
  );

  console.log(`   ⏳ Waiting for deployment transaction...`);
  await governor.waitForDeployment();

  const governorTx = governor.deploymentTransaction();
  console.log(`   📝 Tx Hash: ${governorTx?.hash}`);

  console.log(`   ⏳ Waiting for ${confirmations} confirmation(s)...`);
  await governorTx?.wait(confirmations);

  const governorAddress = await governor.getAddress();
  printDeploymentSummary("JuiceSwapGovernor", governorAddress, networkConfig, governorTx?.hash);

  // ============================================
  // 5. DEPLOY JUICESWAP FEE COLLECTOR
  // ============================================

  console.log("\n📝 Step 2: Deploying JuiceSwapFeeCollector...");

  const JuiceSwapFeeCollectorFactory = await ethers.getContractFactory("JuiceSwapFeeCollector");
  const feeCollectorArgs = [
    JUSD_ADDRESS,
    JUICE_ADDRESS,
    SWAP_ROUTER_ADDRESS,
    FACTORY_ADDRESS,
    governorAddress, // Governor owns FeeCollector
  ];

  const feeCollector = await JuiceSwapFeeCollectorFactory.deploy(
    ...feeCollectorArgs,
    formatGasOverrides(gasConfig, 3000000)
  );

  console.log(`   ⏳ Waiting for deployment transaction...`);
  await feeCollector.waitForDeployment();

  const feeCollectorTx = feeCollector.deploymentTransaction();
  console.log(`   📝 Tx Hash: ${feeCollectorTx?.hash}`);

  console.log(`   ⏳ Waiting for ${confirmations} confirmation(s)...`);
  await feeCollectorTx?.wait(confirmations);

  const feeCollectorAddress = await feeCollector.getAddress();
  printDeploymentSummary("JuiceSwapFeeCollector", feeCollectorAddress, networkConfig, feeCollectorTx?.hash);

  // ============================================
  // 6. TRANSFER FACTORY OWNERSHIP
  // ============================================

  console.log("\n📝 Step 3: Transferring Factory ownership to Governor...");

  const factoryABI = [
    "function owner() view returns (address)",
    "function setOwner(address _owner)",
  ];

  const factoryContract = new ethers.Contract(FACTORY_ADDRESS, factoryABI, deployer);
  const currentFactoryOwner = await factoryContract.owner();
  console.log(`   Current Factory Owner: ${currentFactoryOwner}`);

  if (currentFactoryOwner !== deployer.address) {
    console.log("   ⚠️  Warning: Deployer is not Factory owner!");
    console.log("   Skipping Factory ownership transfer.\n");
  } else {
    const setOwnerTx = await factoryContract.setOwner(
      governorAddress,
      formatGasOverrides(gasConfig, 200000)
    );
    console.log(`   📝 Tx Hash: ${setOwnerTx.hash}`);
    await setOwnerTx.wait(confirmations);
    console.log("   ✅ Factory ownership transferred to Governor\n");
  }

  // ============================================
  // 7. TRANSFER PROXYADMIN OWNERSHIP
  // ============================================

  console.log("📝 Step 4: Transferring ProxyAdmin ownership to Governor...");

  const proxyAdminABI = [
    "function owner() view returns (address)",
    "function transferOwnership(address newOwner)",
  ];

  const proxyAdmin = new ethers.Contract(PROXY_ADMIN_ADDRESS, proxyAdminABI, deployer);
  const currentProxyOwner = await proxyAdmin.owner();
  console.log(`   Current ProxyAdmin Owner: ${currentProxyOwner}`);

  if (currentProxyOwner !== deployer.address) {
    console.log("   ⚠️  Warning: Deployer is not ProxyAdmin owner!");
    console.log("   Skipping ProxyAdmin ownership transfer.\n");
  } else {
    const transferOwnershipTx = await proxyAdmin.transferOwnership(
      governorAddress,
      formatGasOverrides(gasConfig, 200000)
    );
    console.log(`   📝 Tx Hash: ${transferOwnershipTx.hash}`);
    await transferOwnershipTx.wait(confirmations);
    console.log("   ✅ ProxyAdmin ownership transferred to Governor\n");
  }

  // ============================================
  // 8. VERIFY OWNERSHIP TRANSFERS
  // ============================================

  console.log("📝 Step 5: Verifying ownership transfers...\n");

  const newFactoryOwner = await factoryContract.owner();
  const newProxyOwner = await proxyAdmin.owner();
  const feeCollectorOwner = await feeCollector.owner();

  console.log("🔍 Final Ownership:");
  console.log(`   Factory Owner:      ${newFactoryOwner}`);
  console.log(`   ProxyAdmin Owner:   ${newProxyOwner}`);
  console.log(`   FeeCollector Owner: ${feeCollectorOwner}`);
  console.log(`   Governor Address:   ${governorAddress}`);

  const ownershipComplete =
    newFactoryOwner === governorAddress && newProxyOwner === governorAddress;

  if (ownershipComplete) {
    console.log("\n   ✅ All ownership successfully transferred to Governor!");
  } else {
    console.log("\n   ⚠️  Warning: Ownership transfer incomplete!");
  }

  // ============================================
  // 9. SAVE DEPLOYMENT FILE
  // ============================================

  const blockNumber = await ethers.provider.getBlockNumber();

  const governanceState = {
    schemaVersion: "1.0",
    network: {
      name: networkConfig.name,
      chainId: Number(network.chainId),
    },
    deployment: {
      deployedAt: new Date().toISOString(),
      deployedBy: deployer.address,
      blockNumber: blockNumber,
    },
    contracts: {
      JuiceSwapGovernor: {
        address: governorAddress,
        deploymentTx: governorTx?.hash,
        constructorArgs: governorArgs,
      },
      JuiceSwapFeeCollector: {
        address: feeCollectorAddress,
        deploymentTx: feeCollectorTx?.hash,
        constructorArgs: feeCollectorArgs,
      },
    },
    references: {
      jusdAddress: JUSD_ADDRESS,
      juiceAddress: JUICE_ADDRESS,
      factoryAddress: FACTORY_ADDRESS,
      proxyAdminAddress: PROXY_ADMIN_ADDRESS,
      swapRouterAddress: SWAP_ROUTER_ADDRESS,
    },
    ownershipStatus: {
      factoryTransferred: newFactoryOwner === governorAddress,
      proxyAdminTransferred: newProxyOwner === governorAddress,
    },
    metadata: {
      deployer: "JuiceSwapXyz/smart-contracts",
      scriptVersion: "2.0.0",
    },
  };

  const deployDir = path.join(__dirname, "../deployments", networkConfig.folder);
  fs.mkdirSync(deployDir, { recursive: true });
  const governanceFile = path.join(deployDir, "governance.json");
  fs.writeFileSync(governanceFile, JSON.stringify(governanceState, null, 2));
  console.log(`\n📄 Governance deployment saved to: ${governanceFile}`);

  // ============================================
  // 10. VERIFY CONTRACTS
  // ============================================

  console.log("\n📝 Step 6: Verifying contracts on explorer...");

  const governorVerified = await verifyContract(
    governorAddress,
    governorArgs,
    "contracts/governance/JuiceSwapGovernor.sol:JuiceSwapGovernor"
  );

  const feeCollectorVerified = await verifyContract(
    feeCollectorAddress,
    feeCollectorArgs,
    "contracts/governance/JuiceSwapFeeCollector.sol:JuiceSwapFeeCollector"
  );

  // ============================================
  // 11. SUMMARY
  // ============================================

  console.log("\n========================================");
  console.log("   Governance Deployment Complete!     ");
  console.log("========================================\n");

  console.log("📊 Deployed Contracts:");
  console.log(`   Governor:     ${governorAddress}`);
  console.log(`   FeeCollector: ${feeCollectorAddress}`);
  console.log("");

  console.log("📊 Verification Status:");
  console.log(`   Governor:     ${governorVerified ? "✅ Verified" : "❌ Not verified"}`);
  console.log(`   FeeCollector: ${feeCollectorVerified ? "✅ Verified" : "❌ Not verified"}`);
  console.log("");

  console.log("⚙️  Governance Parameters:");
  console.log("   Proposal Fee:        1000 JUSD (goes to JUICE equity)");
  console.log("   Application Period:  14 days minimum");
  console.log("   Veto Quorum:         2% of JUICE voting power");
  console.log("");

  console.log("🤖 Fee Collection:");
  console.log(`   FeeCollector:  ${feeCollectorAddress}`);
  console.log("   Authorized:    Not set (use setAuthorizedCollector proposal)");
  console.log(`   SwapRouter:    ${SWAP_ROUTER_ADDRESS}`);
  console.log("   TWAP Period:   30 minutes");
  console.log("   Max Slippage:  2%");
  console.log("");

  if (networkConfig.explorerUrl) {
    console.log("🔗 Explorer Links:");
    console.log(`   Governor:     ${networkConfig.explorerUrl}/address/${governorAddress}`);
    console.log(`   FeeCollector: ${networkConfig.explorerUrl}/address/${feeCollectorAddress}`);
    console.log("");
  }

  console.log("📘 Next Steps:");
  console.log("   1. Create proposal to set FeeCollector authorized address");
  console.log("   2. Setup keeper bot with private RPC");
  console.log("   3. Announce governance transition to community");
  if (!governorVerified || !feeCollectorVerified) {
    console.log("   4. Manually verify contracts if auto-verification failed");
  }
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Deployment failed:", error);
    process.exit(1);
  });
