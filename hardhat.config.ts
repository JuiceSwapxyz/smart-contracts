import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-verify";
import "hardhat-dependency-compiler";
import "dotenv/config";
import { task } from "hardhat/config";

task("create-nft", "Deploy First Squeezer NFT from image to contract")
  .addParam("image", "Path to NFT image file")
  .setAction(async (taskArgs) => {
    const { main } = await import("./scripts/createNFT");
    await main(taskArgs.image);
  });

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.20",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
      {
        version: "0.7.6",
        settings: {
          optimizer: {
            enabled: true,
            runs: 800,
          },
        },
      },
    ],
  },
  etherscan: {
    apiKey: {
      citreaTestnet: "no-api-key-needed",
      citrea: "no-api-key-needed",
    },
    customChains: [
      {
        network: "citreaTestnet",
        chainId: 5115,
        urls: {
          apiURL: "https://dev.testnet.citreascan.com/api",
          browserURL: "https://dev.testnet.citreascan.com",
        },
      },
      {
        network: "citrea",
        chainId: 4114,
        urls: {
          apiURL: "https://explorer.mainnet.citrea.xyz/api",
          browserURL: "https://explorer.mainnet.citrea.xyz",
        },
      },
    ],
  },
  sourcify: {
    enabled: true,
  },
  networks: {
    hardhat: {
      chainId: process.env.FORK_TESTNET ? 5115 : process.env.FORK_MAINNET ? 4114 : 31337,
      allowUnlimitedContractSize: true,
      forking: process.env.FORK_TESTNET ? {
        url: process.env.CITREA_TESTNET_RPC || "https://rpc.testnet.citrea.xyz",
        enabled: true,
      } : process.env.FORK_MAINNET ? {
        url: process.env.CITREA_MAINNET_RPC || "https://rpc.mainnet.citrea.xyz",
        enabled: true,
      } : undefined,
      chains: {
        5115: { hardforkHistory: { shanghai: 0 } },
        4114: { hardforkHistory: { shanghai: 0 } },
      },
      hardfork: "shanghai",
      initialBaseFeePerGas: 0,
      blockGasLimit: 30_000_000, // 30M gas limit for large contract deployments
      mining: {
        auto: true,
        interval: 0,
      },
    },
    // Localhost networks for persistent forked nodes (optional use)
    forkTestnet: {
      url: "http://127.0.0.1:8545",
      chainId: 5115,
      timeout: 300_000,
    },
    forkMainnet: {
      url: "http://127.0.0.1:8545",
      chainId: 4114,
      timeout: 300_000,
    },
    // Anvil fork networks - use when Hardhat's built-in forking fails (e.g., Governance tests)
    // Start Anvil first: anvil --fork-url https://rpc.testnet.citrea.xyz --chain-id 5115
    anvilTestnet: {
      url: "http://127.0.0.1:8545",
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 5115,
      timeout: 300_000,
    },
    // Start Anvil first: anvil --fork-url https://rpc.mainnet.citrea.xyz --chain-id 4114
    anvilMainnet: {
      url: "http://127.0.0.1:8545",
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 4114,
      timeout: 300_000,
    },
    citreaTestnet: {
      url: process.env.CITREA_TESTNET_RPC || "https://rpc.testnet.citrea.xyz",
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 5115,
      timeout: 300_000,
    },
    citrea: {
      url: process.env.CITREA_MAINNET_RPC || "https://rpc.mainnet.citrea.xyz",
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 4114,
      timeout: 300_000,
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  dependencyCompiler: {
    paths: [
      "@juicedollar/jusd/contracts/JuiceDollar.sol",
      "@juicedollar/jusd/contracts/Equity.sol",
    ],
  },
};

export default config;
