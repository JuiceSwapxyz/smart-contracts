import { ethers, network as hardhatNetwork } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { CHAIN_TO_ADDRESSES_MAP, V3_CORE_FACTORY_ADDRESSES } from "@juiceswapxyz/sdk-core";
import {
  formatGasOverrides,
  getConfirmations,
  getGasConfig,
  getNetworkConfig,
  validateContractDeployed,
  validateMinimumBalance,
  verifyContract,
} from "./utils/deploy-helpers";

const MIN_APPLICATION_PERIOD = 14 * 24 * 60 * 60;
const APPLICATION_PERIOD = Number(process.env.APPLICATION_PERIOD || MIN_APPLICATION_PERIOD);
const VERIFY_CONTRACT = process.env.VERIFY_CONTRACT?.toLowerCase() !== "false";
const SAVE_DEPLOYMENT = process.env.SAVE_DEPLOYMENT?.toLowerCase() !== "false";
const OVERWRITE_DEPLOYMENT = process.env.OVERWRITE_DEPLOYMENT?.toLowerCase() === "true";
const FORCE_UNEXPECTED_FACTORY_OWNER =
  process.env.FORCE_UNEXPECTED_FACTORY_OWNER?.toLowerCase() === "true";
const DISCOVER_POOLS_FROM_CITREASCAN =
  process.env.DISCOVER_POOLS_FROM_CITREASCAN?.toLowerCase() === "true";
const POOL_CREATED_TOPIC =
  "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";

type GovernanceDeployment = {
  contracts: {
    JuiceSwapGovernor?: { address: string };
    JuiceSwapFeeCollector?: { address: string };
  };
  references?: {
    jusdAddress?: string;
    juiceAddress?: string;
    v3FactoryAddress?: string;
    swapRouterAddress?: string;
  };
};

type GovernanceCall = {
  order: number;
  name: string;
  purpose: string;
  target: string;
  data: string;
  description: string;
  governorPropose: {
    target: string;
    data: string;
    applicationPeriod: number;
    description: string;
    calldata: string;
  };
};

function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function parseAddressList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => ethers.getAddress(item));
}

function assertUniqueAddresses(addresses: string[], label: string) {
  const seen = new Set<string>();
  for (const address of addresses) {
    const normalized = address.toLowerCase();
    if (seen.has(normalized)) {
      throw new Error(`${label} contains duplicate address: ${address}`);
    }
    seen.add(normalized);
  }
}

function validateFeeProtocol(value: number, label: string) {
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  if (value !== 0 && (value < 2 || value > 10)) {
    throw new Error(`${label} must be 0 or between 2 and 10`);
  }
}

function buildGovernanceCall(
  order: number,
  name: string,
  purpose: string,
  target: string,
  data: string,
  description: string,
  governorInterface: ethers.Interface
): GovernanceCall {
  return {
    order,
    name,
    purpose,
    target,
    data,
    description,
    governorPropose: {
      target,
      data,
      applicationPeriod: APPLICATION_PERIOD,
      description,
      calldata: governorInterface.encodeFunctionData("propose", [
        target,
        data,
        APPLICATION_PERIOD,
        description,
      ]),
    },
  };
}

async function discoverPoolsFromCitreaScan(factory: string): Promise<string[]> {
  const fromBlock = process.env.POOL_FROM_BLOCK || "2654000";
  const url =
    `https://api.citreascan.com/api?module=logs&action=getLogs` +
    `&fromBlock=${fromBlock}&toBlock=latest&address=${factory}&topic0=${POOL_CREATED_TOPIC}`;

  const response = await fetch(url);
  const body = (await response.json()) as { message?: string; result?: Array<{ data: string }> };
  if (!Array.isArray(body.result)) {
    throw new Error(`Failed to discover pools from CitreaScan: ${JSON.stringify(body).slice(0, 300)}`);
  }

  return body.result.map((log) => ethers.getAddress("0x" + log.data.slice(90, 130)));
}

async function main() {
  if (!Number.isInteger(APPLICATION_PERIOD) || APPLICATION_PERIOD < MIN_APPLICATION_PERIOD) {
    throw new Error(
      `APPLICATION_PERIOD must be at least ${MIN_APPLICATION_PERIOD} seconds (14 days). ` +
      `Received: ${process.env.APPLICATION_PERIOD || APPLICATION_PERIOD}`
    );
  }

  console.log("========================================");
  console.log("   Deploy JuiceSwapFeeCollector V2      ");
  console.log("========================================\n");

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const networkConfig = getNetworkConfig(hardhatNetwork.name);
  const gasConfig = getGasConfig(hardhatNetwork.name);
  const confirmations = getConfirmations(hardhatNetwork.name);

  console.log(`Network: ${networkConfig.name} (chainId ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Application period for generated proposals: ${APPLICATION_PERIOD}s\n`);

  const governanceFile =
    process.env.GOVERNANCE_FILE_PATH ||
    path.join(__dirname, "../deployments", networkConfig.folder, "governance.json");
  const governanceDeployment = readJson<GovernanceDeployment>(governanceFile);
  if (!governanceDeployment) {
    throw new Error(`Missing governance deployment file: ${governanceFile}`);
  }

  const dexAddresses = CHAIN_TO_ADDRESSES_MAP[chainId as keyof typeof CHAIN_TO_ADDRESSES_MAP];
  if (!dexAddresses) throw new Error(`Chain ${chainId} not supported by @juiceswapxyz/sdk-core`);

  const governorAddress = ethers.getAddress(
    process.env.GOVERNOR_ADDRESS || governanceDeployment.contracts.JuiceSwapGovernor?.address || ""
  );
  const oldFeeCollectorAddress = governanceDeployment.contracts.JuiceSwapFeeCollector?.address
    ? ethers.getAddress(governanceDeployment.contracts.JuiceSwapFeeCollector.address)
    : ethers.ZeroAddress;
  const jusdAddress = ethers.getAddress(governanceDeployment.references?.jusdAddress || "");
  const juiceAddress = ethers.getAddress(governanceDeployment.references?.juiceAddress || "");
  const factoryAddress = ethers.getAddress(
    governanceDeployment.references?.v3FactoryAddress ||
      V3_CORE_FACTORY_ADDRESSES[chainId as keyof typeof V3_CORE_FACTORY_ADDRESSES]
  );
  const swapRouterAddress = ethers.getAddress(
    governanceDeployment.references?.swapRouterAddress || dexAddresses.swapRouter02Address
  );
  const authorizedCollectorInput = process.env.AUTHORIZED_COLLECTOR?.trim();
  const authorizedCollector = authorizedCollectorInput
    ? ethers.getAddress(authorizedCollectorInput)
    : null;

  console.log("Resolved addresses:");
  console.log(`  Governor:             ${governorAddress}`);
  console.log(`  Existing FeeCollector:${oldFeeCollectorAddress}`);
  console.log(`  JUSD:                 ${jusdAddress}`);
  console.log(`  JUICE:                ${juiceAddress}`);
  console.log(`  V3 Factory:           ${factoryAddress}`);
  console.log(`  SwapRouter:           ${swapRouterAddress}`);
  console.log(
    `  Keeper collector:     ${authorizedCollector || "not set (Governor owner can collect)"}\n`
  );

  await validateContractDeployed(governorAddress, "Governor");
  if (oldFeeCollectorAddress !== ethers.ZeroAddress) {
    await validateContractDeployed(oldFeeCollectorAddress, "Existing FeeCollector");
  }
  await validateContractDeployed(jusdAddress, "JUSD");
  await validateContractDeployed(juiceAddress, "JUICE");
  await validateContractDeployed(factoryAddress, "V3 Factory");
  await validateContractDeployed(swapRouterAddress, "SwapRouter");

  const estimatedTotalGas = 3500000n;
  const maxFeePerGas = ethers.parseUnits(gasConfig.maxFeePerGas, "gwei");
  await validateMinimumBalance(deployer.address, estimatedTotalGas * maxFeePerGas);

  console.log("Deploying JuiceSwapFeeCollector V2...");
  const FeeCollectorFactory = await ethers.getContractFactory("JuiceSwapFeeCollector");
  const constructorArgs = [
    jusdAddress,
    juiceAddress,
    swapRouterAddress,
    factoryAddress,
    governorAddress,
  ];
  const feeCollector = await FeeCollectorFactory.deploy(
    ...constructorArgs,
    formatGasOverrides(gasConfig, 3000000)
  );
  await feeCollector.waitForDeployment();

  const feeCollectorTx = feeCollector.deploymentTransaction();
  console.log(`  Tx: ${feeCollectorTx?.hash}`);
  await feeCollectorTx?.wait(confirmations);

  const newFeeCollectorAddress = await feeCollector.getAddress();
  console.log(`  New FeeCollector V2: ${newFeeCollectorAddress}\n`);

  const deployedOwner = ethers.getAddress(await feeCollector.owner());
  if (deployedOwner.toLowerCase() !== governorAddress.toLowerCase()) {
    throw new Error(`Post-deploy owner check failed: owner=${deployedOwner}, expected=${governorAddress}`);
  }
  console.log(`  Owner check: ${deployedOwner} ✓\n`);

  const factoryAbi = [
    "function owner() view returns (address)",
    "function setOwner(address _owner)",
  ];
  const oldFeeCollectorAbi = [
    "function setFactoryOwner(address _owner)",
  ];
  const feeCollectorAbi = [
    "function setCollector(address collector)",
    "function setPoolFeeProtocols(address[] pools, uint8[] feeProtocol0, uint8[] feeProtocol1)",
    "function collectAndReinvestFees(address pool, bytes path0, bytes path1) returns (uint256)",
    "function owner() view returns (address)",
    "function authorizedCollector() view returns (address)",
  ];
  const governorAbi = [
    "function propose(address target, bytes data, uint256 applicationPeriod, string description) returns (uint256)",
  ];

  const factory = new ethers.Contract(factoryAddress, factoryAbi, ethers.provider);
  const factoryOwner = ethers.getAddress(await factory.owner());
  const factoryInterface = new ethers.Interface(factoryAbi);
  const oldFeeCollectorInterface = new ethers.Interface(oldFeeCollectorAbi);
  const feeCollectorInterface = new ethers.Interface(feeCollectorAbi);
  const governorInterface = new ethers.Interface(governorAbi);

  const governanceCalls: GovernanceCall[] = [];

  if (factoryOwner.toLowerCase() === governorAddress.toLowerCase()) {
    governanceCalls.push(buildGovernanceCall(
      governanceCalls.length + 1,
      "transfer-v3-factory-owner-to-fee-collector-v2",
      "Make FeeCollector V2 the V3 factory owner so it can call pool admin and collectProtocol.",
      factoryAddress,
      factoryInterface.encodeFunctionData("setOwner", [newFeeCollectorAddress]),
      "Transfer V3 factory ownership to FeeCollector V2",
      governorInterface
    ));
  } else if (factoryOwner.toLowerCase() === oldFeeCollectorAddress.toLowerCase()) {
    governanceCalls.push(buildGovernanceCall(
      governanceCalls.length + 1,
      "old-fee-collector-transfers-v3-factory-owner-to-v2",
      "Use the existing Governor-owned FeeCollector to hand V3 factory ownership to FeeCollector V2.",
      oldFeeCollectorAddress,
      oldFeeCollectorInterface.encodeFunctionData("setFactoryOwner", [newFeeCollectorAddress]),
      "Transfer V3 factory ownership from old FeeCollector to FeeCollector V2",
      governorInterface
    ));
  } else if (factoryOwner.toLowerCase() === newFeeCollectorAddress.toLowerCase()) {
    console.log("Factory already owned by the new FeeCollector; no ownership proposal needed.");
  } else {
    const message =
      `Unexpected V3 factory owner: ${factoryOwner}. ` +
      `Expected Governor ${governorAddress}, old FeeCollector ${oldFeeCollectorAddress}, ` +
      `or new FeeCollector ${newFeeCollectorAddress}. Refusing to generate an incomplete plan.`;
    if (!FORCE_UNEXPECTED_FACTORY_OWNER) {
      throw new Error(`${message} Set FORCE_UNEXPECTED_FACTORY_OWNER=true to bypass.`);
    }
    console.log(`WARNING: ${message}`);
  }

  if (!authorizedCollector) {
    console.log("No AUTHORIZED_COLLECTOR provided; skipping setCollector proposal.");
    console.log("Governor can still collect because it owns FeeCollector V2.");
  } else if (authorizedCollector.toLowerCase() === governorAddress.toLowerCase()) {
    console.log("AUTHORIZED_COLLECTOR is the Governor; skipping redundant setCollector proposal.");
    console.log("Governor can already collect because it owns FeeCollector V2.");
  } else {
    governanceCalls.push(buildGovernanceCall(
      governanceCalls.length + 1,
      "set-authorized-collector",
      "Authorize a keeper account. The Governor can also collect because it owns FeeCollector V2.",
      newFeeCollectorAddress,
      feeCollectorInterface.encodeFunctionData("setCollector", [authorizedCollector]),
      `Set FeeCollector V2 authorized collector to ${authorizedCollector}`,
      governorInterface
    ));
  }

  let poolAddresses = parseAddressList(process.env.POOL_ADDRESSES);
  if (DISCOVER_POOLS_FROM_CITREASCAN) {
    poolAddresses = await discoverPoolsFromCitreaScan(factoryAddress);
    console.log(`Discovered ${poolAddresses.length} pools from CitreaScan.`);
  }
  assertUniqueAddresses(poolAddresses, "Pool list");

  let feeProtocol0: number | null = null;
  let feeProtocol1: number | null = null;
  if (poolAddresses.length > 0) {
    const sharedFeeProtocol = process.env.FEE_PROTOCOL;
    feeProtocol0 = Number(process.env.FEE_PROTOCOL0 || sharedFeeProtocol);
    feeProtocol1 = Number(process.env.FEE_PROTOCOL1 || sharedFeeProtocol);

    if (!Number.isFinite(feeProtocol0) || !Number.isFinite(feeProtocol1)) {
      throw new Error(
        "POOL_ADDRESSES/DISCOVER_POOLS_FROM_CITREASCAN requires FEE_PROTOCOL or both FEE_PROTOCOL0 and FEE_PROTOCOL1."
      );
    }

    validateFeeProtocol(feeProtocol0, "FEE_PROTOCOL0");
    validateFeeProtocol(feeProtocol1, "FEE_PROTOCOL1");

    governanceCalls.push(buildGovernanceCall(
      governanceCalls.length + 1,
      "set-pool-fee-protocols",
      "Activate or update the V3 protocol fee on the selected pools.",
      newFeeCollectorAddress,
      feeCollectorInterface.encodeFunctionData("setPoolFeeProtocols", [
        poolAddresses,
        poolAddresses.map(() => feeProtocol0),
        poolAddresses.map(() => feeProtocol1),
      ]),
      `Set V3 pool protocol fees to ${feeProtocol0}/${feeProtocol1} on ${poolAddresses.length} pools`,
      governorInterface
    ));
  }

  const blockNumber = await ethers.provider.getBlockNumber();
  const output = {
    schemaVersion: "1.0",
    network: {
      name: networkConfig.name,
      chainId,
    },
    deployment: {
      deployedAt: new Date().toISOString(),
      deployedBy: deployer.address,
      blockNumber,
    },
    contracts: {
      JuiceSwapFeeCollectorV2: {
        address: newFeeCollectorAddress,
        deploymentTx: feeCollectorTx?.hash,
        constructorArgs,
      },
    },
    references: {
      governorAddress,
      oldFeeCollectorAddress,
      jusdAddress,
      juiceAddress,
      v3FactoryAddress: factoryAddress,
      swapRouterAddress,
      factoryOwnerBefore: factoryOwner,
      authorizedCollector: authorizedCollector || null,
    },
    selectedPools: poolAddresses,
    selectedFeeProtocol: poolAddresses.length > 0 ? { feeProtocol0, feeProtocol1 } : null,
    governancePlan: {
      applicationPeriod: APPLICATION_PERIOD,
      proposalCount: governanceCalls.length,
      proposalFeeJusd: governanceCalls.length * 1000,
      proposalFeeWei: (BigInt(governanceCalls.length) * 1000n * 10n ** 18n).toString(),
      instructions: [
        `Approve at least ${governanceCalls.length * 1000} JUSD (${(BigInt(governanceCalls.length) * 1000n * 10n ** 18n).toString()} wei) to the Governor at ${governorAddress}.`,
        "Submit each governorPropose.calldata to Governor.propose in the listed order.",
        `Wait at least ${APPLICATION_PERIOD} seconds after each proposal is submitted.`,
        "Execute the proposals in the listed order after their application periods pass.",
        "After execution, verify factory.owner(), authorizedCollector if configured, and each selected pool's slot0().feeProtocol.",
      ],
      calls: governanceCalls,
    },
    collectionNote: {
      governorCanCollect:
        "FeeCollector V2 permits owner() to call collectAndReinvestFees, so the Governor can collect through a proposal even when a keeper is authorized.",
      keeperCanCollect:
        "The setCollector proposal authorizes the selected collector to call collectAndReinvestFees directly.",
      collectCall:
        "collectAndReinvestFees(pool, path0, path1) still needs correct per-pool swap paths ending in JUSD and adequate TWAP cardinality.",
    },
    metadata: {
      deployer: "JuiceSwapXyz/smart-contracts",
      script: "scripts/deploy-fee-collector-v2.ts",
      scriptVersion: "1.0.0",
    },
  };

  if (SAVE_DEPLOYMENT) {
    const deployDir = path.join(__dirname, "../deployments", networkConfig.folder);
    fs.mkdirSync(deployDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputFile =
      process.env.OUTPUT_FILE ||
      path.join(deployDir, `fee-collector-v2-${timestamp}.json`);
    if (fs.existsSync(outputFile) && !OVERWRITE_DEPLOYMENT) {
      throw new Error(
        `Refusing to overwrite existing deployment file: ${outputFile}. ` +
        `Set OVERWRITE_DEPLOYMENT=true or OUTPUT_FILE to a new path.`
      );
    }
    fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
    console.log(`Deployment and governance plan saved to: ${outputFile}\n`);
  } else {
    console.log("Skipping deployment file write (SAVE_DEPLOYMENT=false).\n");
  }

  if (VERIFY_CONTRACT) {
    await verifyContract(
      newFeeCollectorAddress,
      constructorArgs,
      "contracts/governance/JuiceSwapFeeCollector.sol:JuiceSwapFeeCollector"
    );
  } else {
    console.log("Skipping explorer verification (VERIFY_CONTRACT=false).");
  }

  console.log("Required governance calls:");
  for (const call of governanceCalls) {
    console.log(`\n${call.order}. ${call.name}`);
    console.log(`   target: ${call.target}`);
    console.log(`   data:   ${call.data}`);
    console.log(`   propose calldata: ${call.governorPropose.calldata}`);
  }

  console.log("\nDone.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\nDeployment failed:", error);
    process.exit(1);
  });
