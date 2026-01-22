import { ethers, run, network as hardhatNetwork } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// ============================================
// Type Definitions
// ============================================

export interface GasConfig {
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}

export interface NetworkConfig {
  name: string;
  folder: string;
  explorerUrl: string;
  isLocal: boolean;
}

export interface DeploymentInfo {
  schemaVersion: string;
  network: {
    name: string;
    chainId: number;
  };
  deployment: {
    deployedAt: string;
    deployedBy: string;
    blockNumber: number;
  };
  contracts: Record<string, {
    address: string;
    deploymentTx?: string;
    constructorArgs: any[];
  }>;
  references?: Record<string, string>;
  metadata: {
    deployer: string;
    scriptVersion: string;
  };
}

// ============================================
// Network Configurations
// ============================================

export const NETWORK_CONFIGS: Record<string, NetworkConfig> = {
  hardhat: {
    name: "Localhost (Hardhat)",
    folder: "localhost",
    explorerUrl: "",
    isLocal: true,
  },
  localhost: {
    name: "Localhost",
    folder: "localhost",
    explorerUrl: "",
    isLocal: true,
  },
  citreaTestnet: {
    name: "Citrea Testnet",
    folder: "testnet",
    explorerUrl: "https://explorer.testnet.citrea.xyz",
    isLocal: false,
  },
  citrea: {
    name: "Citrea Mainnet",
    folder: "mainnet",
    explorerUrl: "https://explorer.citrea.xyz",
    isLocal: false,
  },
};

// Gas configs (values in gwei)
const GAS_CONFIGS: Record<string, GasConfig> = {
  hardhat: {
    maxFeePerGas: "10",
    maxPriorityFeePerGas: "1",
  },
  localhost: {
    maxFeePerGas: "10",
    maxPriorityFeePerGas: "1",
  },
  citreaTestnet: {
    maxFeePerGas: "0.01",
    maxPriorityFeePerGas: "0.001",
  },
  citrea: {
    // Mainnet: same as testnet for Citrea
    maxFeePerGas: "0.01",
    maxPriorityFeePerGas: "0.001",
  },
};

// ============================================
// Configuration Getters
// ============================================

/**
 * Get gas configuration for a specific network
 */
export function getGasConfig(networkName: string): GasConfig {
  const config = GAS_CONFIGS[networkName];
  if (!config) {
    console.warn(`⚠️  Unknown network "${networkName}", using citreaTestnet gas config`);
    return GAS_CONFIGS.citreaTestnet;
  }
  return config;
}

/**
 * Get network configuration
 */
export function getNetworkConfig(networkName: string): NetworkConfig {
  const config = NETWORK_CONFIGS[networkName];
  if (!config) {
    console.warn(`⚠️  Unknown network "${networkName}", using citreaTestnet config`);
    return NETWORK_CONFIGS.citreaTestnet;
  }
  return config;
}

/**
 * Get number of confirmations to wait based on network
 * - Local networks: 1 confirmation
 * - Live networks: 6 confirmations for safety
 */
export function getConfirmations(networkName: string): number {
  const config = getNetworkConfig(networkName);
  return config.isLocal ? 1 : 6;
}

/**
 * Format gas overrides for transaction
 */
export function formatGasOverrides(config: GasConfig, gasLimit?: number): {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimit?: number;
} {
  const overrides: {
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    gasLimit?: number;
  } = {
    maxFeePerGas: ethers.parseUnits(config.maxFeePerGas, "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits(config.maxPriorityFeePerGas, "gwei"),
  };
  if (gasLimit) {
    overrides.gasLimit = gasLimit;
  }
  return overrides;
}

// ============================================
// Pre-deployment Validation
// ============================================

/**
 * Validate that deployer has sufficient balance for deployment
 * @param deployer - Deployer address
 * @param estimatedGasCost - Estimated gas cost in wei
 * @param buffer - Additional buffer in wei (default: 0.001 cBTC)
 */
export async function validateMinimumBalance(
  deployer: string,
  estimatedGasCost: bigint,
  buffer: bigint = ethers.parseEther("0.001")
): Promise<void> {
  const balance = await ethers.provider.getBalance(deployer);
  const required = estimatedGasCost + buffer;

  console.log(`💰 Deployer balance: ${ethers.formatEther(balance)} cBTC`);
  console.log(`💰 Estimated required: ${ethers.formatEther(required)} cBTC`);

  if (balance < required) {
    throw new Error(
      `❌ Insufficient balance!\n` +
      `   Current: ${ethers.formatEther(balance)} cBTC\n` +
      `   Required: ${ethers.formatEther(required)} cBTC\n` +
      `   Please fund deployer address: ${deployer}`
    );
  }

  console.log("✅ Balance check passed\n");
}

/**
 * Validate that a contract is deployed at the given address
 * @param address - Contract address to check
 * @param name - Human-readable name for error messages
 */
export async function validateContractDeployed(
  address: string,
  name: string
): Promise<void> {
  const code = await ethers.provider.getCode(address);
  if (code === "0x") {
    throw new Error(
      `❌ No contract deployed at ${name} address!\n` +
      `   Address: ${address}\n` +
      `   Please verify the address is correct and contract is deployed.`
    );
  }
}

/**
 * Validate multiple contract addresses
 */
export async function validateContractsDeployed(
  contracts: Array<{ address: string; name: string }>
): Promise<void> {
  console.log("🔍 Validating dependency contracts...");

  for (const { address, name } of contracts) {
    await validateContractDeployed(address, name);
    console.log(`   ✅ ${name}: ${address}`);
  }

  console.log("");
}

// ============================================
// Contract Verification
// ============================================

/**
 * Verify a contract on the block explorer with retry logic
 * @param address - Contract address
 * @param constructorArgs - Constructor arguments
 * @param contractPath - Optional contract path (e.g., "contracts/MyContract.sol:MyContract")
 * @returns true if verification succeeded, false otherwise
 */
export async function verifyContract(
  address: string,
  constructorArgs: any[],
  contractPath?: string
): Promise<boolean> {
  const networkConfig = getNetworkConfig(hardhatNetwork.name);

  if (networkConfig.isLocal) {
    console.log("   ⏭️  Skipping verification on local network");
    return true;
  }

  console.log(`\n🔍 Verifying contract at ${address}...`);

  // Wait for block explorer to index the contract
  const indexingDelay = 30000; // 30 seconds
  console.log(`   ⏳ Waiting ${indexingDelay / 1000}s for block explorer to index...`);
  await sleep(indexingDelay);

  const maxRetries = 3;
  const retryDelay = 15000; // 15 seconds

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const verifyArgs: {
        address: string;
        constructorArguments: any[];
        contract?: string;
      } = {
        address,
        constructorArguments: constructorArgs,
      };

      if (contractPath) {
        verifyArgs.contract = contractPath;
      }

      await run("verify:verify", verifyArgs);
      console.log("   ✅ Contract verified successfully!");
      return true;
    } catch (error: any) {
      const errorMessage = error.message || String(error);

      // Already verified is success
      if (errorMessage.includes("Already Verified") || errorMessage.includes("already verified")) {
        console.log("   ✅ Contract already verified");
        return true;
      }

      // Retry on transient errors
      if (attempt < maxRetries) {
        console.log(`   ⚠️  Verification attempt ${attempt}/${maxRetries} failed`);
        console.log(`   📝 Error: ${errorMessage.substring(0, 100)}...`);
        console.log(`   ⏳ Retrying in ${retryDelay / 1000}s...`);
        await sleep(retryDelay);
      } else {
        console.log(`   ❌ Verification failed after ${maxRetries} attempts`);
        console.log(`   📝 Error: ${errorMessage}`);
        console.log(`\n   📋 Manual verification command:`);
        console.log(`   npx hardhat verify --network ${hardhatNetwork.name} ${address} ${constructorArgs.join(" ")}`);
        return false;
      }
    }
  }

  return false;
}

// ============================================
// Deployment File Management
// ============================================

/**
 * Save deployment information to a JSON file
 * @param folder - Deployment folder (e.g., "testnet", "mainnet")
 * @param filename - Filename (e.g., "gateway.json")
 * @param data - Deployment data to save
 * @returns Full path to saved file
 */
export function saveDeployment(
  folder: string,
  filename: string,
  data: DeploymentInfo
): string {
  const deployDir = path.join(__dirname, "../../deployments", folder);
  fs.mkdirSync(deployDir, { recursive: true });

  const filePath = path.join(deployDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

  console.log(`📄 Deployment saved to: ${filePath}`);
  return filePath;
}

/**
 * Build deployment info object
 */
export function buildDeploymentInfo(params: {
  networkName: string;
  chainId: number;
  deployer: string;
  blockNumber: number;
  contracts: Record<string, { address: string; deploymentTx?: string; constructorArgs: any[] }>;
  references?: Record<string, string>;
  scriptVersion?: string;
}): DeploymentInfo {
  return {
    schemaVersion: "1.0",
    network: {
      name: params.networkName,
      chainId: params.chainId,
    },
    deployment: {
      deployedAt: new Date().toISOString(),
      deployedBy: params.deployer,
      blockNumber: params.blockNumber,
    },
    contracts: params.contracts,
    references: params.references,
    metadata: {
      deployer: "JuiceSwapXyz/smart-contracts",
      scriptVersion: params.scriptVersion || "1.0.0",
    },
  };
}

// ============================================
// Utility Functions
// ============================================

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Print deployment summary with explorer links
 */
export function printDeploymentSummary(
  contractName: string,
  address: string,
  networkConfig: NetworkConfig,
  txHash?: string
): void {
  console.log(`\n✅ ${contractName} deployed!`);
  console.log(`   Address: ${address}`);
  if (txHash) {
    console.log(`   Tx Hash: ${txHash}`);
  }
  if (networkConfig.explorerUrl) {
    console.log(`   Explorer: ${networkConfig.explorerUrl}/address/${address}`);
  }
}

/**
 * Estimate deployment gas cost
 */
export async function estimateDeploymentGas(
  factory: any,
  constructorArgs: any[],
  gasConfig: GasConfig
): Promise<bigint> {
  try {
    const deployTx = await factory.getDeployTransaction(...constructorArgs);
    const estimatedGas = await ethers.provider.estimateGas(deployTx);
    const maxFeePerGas = ethers.parseUnits(gasConfig.maxFeePerGas, "gwei");
    return estimatedGas * maxFeePerGas;
  } catch (error) {
    // Fallback estimate if estimation fails
    console.log("⚠️  Gas estimation failed, using fallback estimate");
    const fallbackGas = 3000000n; // 3M gas
    const maxFeePerGas = ethers.parseUnits(gasConfig.maxFeePerGas, "gwei");
    return fallbackGas * maxFeePerGas;
  }
}
