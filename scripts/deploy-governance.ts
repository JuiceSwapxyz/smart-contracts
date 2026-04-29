import { ethers, network as hardhatNetwork } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { ADDRESS } from "@juicedollar/jusd";
import { V3_CORE_FACTORY_ADDRESSES, V2_FACTORY_ADDRESSES, CHAIN_TO_ADDRESSES_MAP } from "@juiceswapxyz/sdk-core";
import { ADDRESS as LAUNCHPAD_ADDRESS } from "@juiceswapxyz/launchpad";
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
 * Deploy JuiceSwapGovernor and JuiceSwapFeeCollectorV2, optionally transferring
 * ownership of V3 Factory, V2 Factory, ProxyAdmin, and TokenFactory to the Governor.
 *
 * This script:
 * 1. Gets addresses from canonical packages (@juicedollar/jusd, @juiceswapxyz/sdk-core, @juiceswapxyz/launchpad)
 * 2. Checks deployer balance
 * 3. Deploys JuiceSwapGovernor
 * 4. Deploys JuiceSwapFeeCollectorV2 (owned by Governor)
 * 5. Optionally transfers V3 Factory ownership to Governor (if TRANSFER_OWNERSHIP=true)
 * 6. Optionally transfers V2 Factory feeToSetter to Governor (if TRANSFER_OWNERSHIP=true)
 * 7. Optionally transfers ProxyAdmin ownership to Governor (if TRANSFER_OWNERSHIP=true)
 * 8. Optionally transfers TokenFactory ownership to Governor (if TRANSFER_OWNERSHIP=true)
 * 9. Saves deployment info to JSON
 * 10. Verifies both contracts on block explorer
 *
 * Note: V2 Factory uses `feeToSetter` role instead of `owner`. The feeToSetter can:
 * - Call setFeeTo(address) to set protocol fee recipient
 * - Call setFeeToSetter(address) to transfer control
 *
 * Environment variables:
 * - TRANSFER_OWNERSHIP: Set to "true" to transfer all ownership to the Governor.
 *                       Default is "false" (deploy contracts only).
 */

// All addresses are now imported from packages - no .env required for addresses!

// Ownership transfer flag - default is false (deploy contracts only, no ownership transfer)
const TRANSFER_OWNERSHIP = process.env.TRANSFER_OWNERSHIP?.toLowerCase() === "true";

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
  console.log(`🔐 Transfer Ownership: ${TRANSFER_OWNERSHIP ? "YES" : "NO (deploy only)"}`);
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
  const PROXY_ADMIN_ADDRESS = dexAddresses.proxyAdminAddress;

  // Get TokenFactory address from launchpad package
  const launchpadAddresses = LAUNCHPAD_ADDRESS[chainIdNum];
  const TOKENFACTORY_ADDRESS = launchpadAddresses?.factory;

  // TokenFactory is optional - only validate if launchpad is deployed
  const hasTokenFactory = TOKENFACTORY_ADDRESS && TOKENFACTORY_ADDRESS !== "0x0000000000000000000000000000000000000000";

  // Validate all addresses are defined
  if (!FACTORY_ADDRESS) {
    throw new Error(`❌ Factory not defined for chain ${chainIdNum}`);
  }
  if (!SWAP_ROUTER_ADDRESS) {
    throw new Error(`❌ SwapRouter not defined for chain ${chainIdNum}`);
  }
  if (!PROXY_ADMIN_ADDRESS) {
    throw new Error(`❌ ProxyAdmin not defined for chain ${chainIdNum}`);
  }

  console.log("📦 Addresses from packages (single source of truth):");
  console.log(`   JUSD:        ${JUSD_ADDRESS} (from @juicedollar/jusd)`);
  console.log(`   JUICE:       ${JUICE_ADDRESS} (from @juicedollar/jusd)`);
  console.log(`   Factory:     ${FACTORY_ADDRESS} (from @juiceswapxyz/sdk-core)`);
  console.log(`   SwapRouter:  ${SWAP_ROUTER_ADDRESS} (from @juiceswapxyz/sdk-core)`);
  console.log(`   ProxyAdmin:  ${PROXY_ADMIN_ADDRESS} (from @juiceswapxyz/sdk-core)`);
  if (hasTokenFactory) {
    console.log(`   TokenFactory: ${TOKENFACTORY_ADDRESS} (from @juiceswapxyz/launchpad)`);
  }
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

  if (hasTokenFactory) {
    await validateContractDeployed(TOKENFACTORY_ADDRESS, "TokenFactory");
    console.log(`   ✅ TokenFactory: ${TOKENFACTORY_ADDRESS}`);
  }
  console.log("");

  // ============================================
  // 3. ESTIMATE GAS & VALIDATE BALANCE
  // ============================================

  console.log("💰 Checking deployer balance...");

  // Estimate gas for both deployments + ownership transfers
  // Governor: ~1.5M gas, FeeCollectorV2: ~2.5M gas, transfers: ~0.2M each
  const estimatedTotalGas = 5000000n; // 5M gas total estimate
  const maxFeePerGas = ethers.parseUnits(gasConfig.maxFeePerGas, "gwei");
  const estimatedCost = estimatedTotalGas * maxFeePerGas;

  await validateMinimumBalance(deployer.address, estimatedCost, 0n);

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

  console.log("\n📝 Step 2: Deploying JuiceSwapFeeCollectorV2...");

  const JuiceSwapFeeCollectorFactory = await ethers.getContractFactory("JuiceSwapFeeCollectorV2");
  const feeCollectorArgs = [
    JUSD_ADDRESS,
    JUICE_ADDRESS,
    SWAP_ROUTER_ADDRESS,
    FACTORY_ADDRESS,
    governorAddress, // Governor owns FeeCollectorV2
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
  printDeploymentSummary("JuiceSwapFeeCollectorV2", feeCollectorAddress, networkConfig, feeCollectorTx?.hash);

  // ============================================
  // 6. TRANSFER FACTORY OWNERSHIP (if enabled)
  // ============================================

  console.log("\n📝 Step 3: Factory ownership...");

  const factoryABI = [
    "function owner() view returns (address)",
    "function setOwner(address _owner)",
  ];

  const factoryContract = new ethers.Contract(FACTORY_ADDRESS, factoryABI, deployer);
  const currentFactoryOwner = await factoryContract.owner();
  console.log(`   Current Factory Owner: ${currentFactoryOwner}`);

  if (!TRANSFER_OWNERSHIP) {
    console.log("   ⏭️  Skipping ownership transfer (TRANSFER_OWNERSHIP=false)\n");
  } else if (currentFactoryOwner !== deployer.address) {
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
  // 7. TRANSFER V2 FACTORY FEETOSETTER (if enabled)
  // ============================================

  console.log("📝 Step 4: V2 Factory feeToSetter...");

  // Get V2 Factory address from SDK
  const V2_FACTORY_ADDRESS = V2_FACTORY_ADDRESSES[chainIdNum as keyof typeof V2_FACTORY_ADDRESSES];
  let v2FactoryTransferred = false;

  if (!V2_FACTORY_ADDRESS || V2_FACTORY_ADDRESS === "0x0000000000000000000000000000000000000000") {
    console.log("   ⏭️  V2 Factory not deployed on this chain\n");
  } else {
    const v2FactoryABI = [
      "function feeToSetter() view returns (address)",
      "function setFeeToSetter(address _feeToSetter)",
      "function feeTo() view returns (address)",
    ];

    const v2Factory = new ethers.Contract(V2_FACTORY_ADDRESS, v2FactoryABI, deployer);
    const currentFeeToSetter = await v2Factory.feeToSetter();
    const currentFeeTo = await v2Factory.feeTo();

    console.log(`   V2 Factory Address:  ${V2_FACTORY_ADDRESS}`);
    console.log(`   Current feeToSetter: ${currentFeeToSetter}`);
    console.log(`   Current feeTo:       ${currentFeeTo} (${currentFeeTo === ethers.ZeroAddress ? "fees disabled" : "fees enabled"})`);

    if (!TRANSFER_OWNERSHIP) {
      console.log("   ⏭️  Skipping transfer (TRANSFER_OWNERSHIP=false)\n");
    } else if (currentFeeToSetter !== deployer.address) {
      console.log("   ⚠️  Warning: Deployer is not V2 Factory feeToSetter!");
      console.log("   Skipping V2 Factory transfer.\n");
    } else {
      const transferTx = await v2Factory.setFeeToSetter(
        governorAddress,
        formatGasOverrides(gasConfig, 100000)
      );
      console.log(`   📝 Tx Hash: ${transferTx.hash}`);
      await transferTx.wait(confirmations);
      console.log("   ✅ V2 Factory feeToSetter transferred to Governor\n");
    }

    const newFeeToSetter = await v2Factory.feeToSetter();
    v2FactoryTransferred = newFeeToSetter === governorAddress;
  }

  // ============================================
  // 8. TRANSFER PROXYADMIN OWNERSHIP (if enabled)
  // ============================================

  console.log("📝 Step 5: ProxyAdmin ownership...");

  const proxyAdminABI = [
    "function owner() view returns (address)",
    "function transferOwnership(address newOwner)",
  ];

  const proxyAdmin = new ethers.Contract(PROXY_ADMIN_ADDRESS, proxyAdminABI, deployer);
  const currentProxyOwner = await proxyAdmin.owner();
  console.log(`   Current ProxyAdmin Owner: ${currentProxyOwner}`);

  if (!TRANSFER_OWNERSHIP) {
    console.log("   ⏭️  Skipping ownership transfer (TRANSFER_OWNERSHIP=false)\n");
  } else if (currentProxyOwner !== deployer.address) {
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
  // 9. TRANSFER TOKENFACTORY OWNERSHIP (if enabled and deployed)
  // ============================================

  let tokenFactoryTransferred = false;

  if (hasTokenFactory) {
    console.log("📝 Step 6: TokenFactory ownership...");

    const tokenFactoryABI = [
      "function owner() view returns (address)",
      "function transferOwnership(address newOwner)",
    ];

    const tokenFactory = new ethers.Contract(TOKENFACTORY_ADDRESS, tokenFactoryABI, deployer);
    const currentTokenFactoryOwner = await tokenFactory.owner();
    console.log(`   Current TokenFactory Owner: ${currentTokenFactoryOwner}`);

    if (!TRANSFER_OWNERSHIP) {
      console.log("   ⏭️  Skipping ownership transfer (TRANSFER_OWNERSHIP=false)\n");
    } else if (currentTokenFactoryOwner !== deployer.address) {
      console.log("   ⚠️  Warning: Deployer is not TokenFactory owner!");
      console.log("   Skipping TokenFactory ownership transfer.\n");
    } else {
      const transferTx = await tokenFactory.transferOwnership(
        governorAddress,
        formatGasOverrides(gasConfig, 200000)
      );
      console.log(`   📝 Tx Hash: ${transferTx.hash}`);
      await transferTx.wait(confirmations);
      console.log("   ✅ TokenFactory ownership transferred to Governor\n");
    }

    const newTokenFactoryOwner = await tokenFactory.owner();
    tokenFactoryTransferred = newTokenFactoryOwner === governorAddress;
  } else {
    console.log("📝 Step 6: TokenFactory ownership...");
    console.log("   ⏭️  TokenFactory not deployed on this chain\n");
  }

  // ============================================
  // 10. VERIFY OWNERSHIP TRANSFERS
  // ============================================

  console.log("📝 Step 7: Verifying ownership transfers...\n");

  const newFactoryOwner = await factoryContract.owner();
  const newProxyOwner = await proxyAdmin.owner();
  const feeCollectorOwner = await feeCollector.owner();

  // Check V2 Factory final state
  const hasV2Factory = V2_FACTORY_ADDRESS && V2_FACTORY_ADDRESS !== "0x0000000000000000000000000000000000000000";
  let finalV2FeeToSetter = null;
  if (hasV2Factory) {
    const v2Factory = new ethers.Contract(V2_FACTORY_ADDRESS, ["function feeToSetter() view returns (address)"], deployer);
    finalV2FeeToSetter = await v2Factory.feeToSetter();
  }

  console.log("🔍 Final Ownership:");
  console.log(`   V3 Factory Owner:     ${newFactoryOwner}`);
  if (hasV2Factory) {
    console.log(`   V2 Factory feeToSetter: ${finalV2FeeToSetter}`);
  }
  console.log(`   ProxyAdmin Owner:     ${newProxyOwner}`);
  if (hasTokenFactory) {
    const tokenFactory = new ethers.Contract(TOKENFACTORY_ADDRESS, ["function owner() view returns (address)"], deployer);
    const finalTokenFactoryOwner = await tokenFactory.owner();
    console.log(`   TokenFactory Owner:   ${finalTokenFactoryOwner}`);
  }
  console.log(`   FeeCollectorV2 Owner: ${feeCollectorOwner}`);
  console.log(`   Governor Address:     ${governorAddress}`);

  const ownershipComplete =
    newFactoryOwner === governorAddress &&
    newProxyOwner === governorAddress &&
    (!hasV2Factory || v2FactoryTransferred) &&
    (!hasTokenFactory || tokenFactoryTransferred);

  if (ownershipComplete) {
    console.log("\n   ✅ All ownership successfully transferred to Governor!");
  } else {
    console.log("\n   ⚠️  Warning: Ownership transfer incomplete!");
  }

  // ============================================
  // 10. SAVE DEPLOYMENT FILE
  // ============================================

  const blockNumber = await ethers.provider.getBlockNumber();

  const governanceState = {
    schemaVersion: "2.0",
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
      JuiceSwapFeeCollectorV2: {
        address: feeCollectorAddress,
        deploymentTx: feeCollectorTx?.hash,
        constructorArgs: feeCollectorArgs,
      },
    },
    references: {
      jusdAddress: JUSD_ADDRESS,
      juiceAddress: JUICE_ADDRESS,
      v3FactoryAddress: FACTORY_ADDRESS,
      v2FactoryAddress: hasV2Factory ? V2_FACTORY_ADDRESS : null,
      proxyAdminAddress: PROXY_ADMIN_ADDRESS,
      swapRouterAddress: SWAP_ROUTER_ADDRESS,
      tokenFactoryAddress: hasTokenFactory ? TOKENFACTORY_ADDRESS : null,
    },
    ownershipStatus: {
      v3FactoryTransferred: newFactoryOwner === governorAddress,
      v2FactoryTransferred: hasV2Factory ? v2FactoryTransferred : "N/A (not deployed)",
      proxyAdminTransferred: newProxyOwner === governorAddress,
      tokenFactoryTransferred: hasTokenFactory ? tokenFactoryTransferred : "N/A (not deployed)",
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
  // 12. VERIFY CONTRACTS
  // ============================================

  console.log("\n📝 Step 8: Verifying contracts on explorer...");

  const governorVerified = await verifyContract(
    governorAddress,
    governorArgs,
    "contracts/governance/JuiceSwapGovernor.sol:JuiceSwapGovernor"
  );

  const feeCollectorVerified = await verifyContract(
    feeCollectorAddress,
    feeCollectorArgs,
    "contracts/governance/JuiceSwapFeeCollectorV2.sol:JuiceSwapFeeCollectorV2"
  );

  // ============================================
  // 12. SUMMARY
  // ============================================

  console.log("\n========================================");
  console.log("   Governance Deployment Complete!     ");
  console.log("========================================\n");

  console.log("📊 Deployed Contracts:");
  console.log(`   Governor:     ${governorAddress}`);
  console.log(`   FeeCollectorV2: ${feeCollectorAddress}`);
  console.log("");

  console.log("📊 Verification Status:");
  console.log(`   Governor:     ${governorVerified ? "✅ Verified" : "❌ Not verified"}`);
  console.log(`   FeeCollectorV2: ${feeCollectorVerified ? "✅ Verified" : "❌ Not verified"}`);
  console.log("");

  console.log("⚙️  Governance Parameters:");
  console.log("   Proposal Fee:        1000 JUSD (goes to JUICE equity)");
  console.log("   Application Period:  14 days minimum");
  console.log("   Veto Quorum:         2% of JUICE voting power");
  console.log("");

  console.log("🤖 Fee Collection:");
  console.log(`   FeeCollectorV2: ${feeCollectorAddress}`);
  console.log("   Authorized:    Not set (use setCollector proposal)");
  console.log(`   SwapRouter:    ${SWAP_ROUTER_ADDRESS}`);
  console.log("   TWAP Period:   30 minutes");
  console.log("   Max Slippage:  2%");
  console.log("");

  if (networkConfig.explorerUrl) {
    console.log("🔗 Explorer Links:");
    console.log(`   Governor:     ${networkConfig.explorerUrl}/address/${governorAddress}`);
    console.log(`   FeeCollectorV2: ${networkConfig.explorerUrl}/address/${feeCollectorAddress}`);
    console.log("");
  }

  console.log("📘 Next Steps:");
  console.log("   1. Create proposal to set FeeCollectorV2 authorized address");
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
