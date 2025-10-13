import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "dotenv/config";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      forking: process.env.FORK_CITREA === "true" ? {
        url: process.env.CITREA_RPC_URL || "https://rpc.testnet.citrea.xyz",
        enabled: true,
      } : undefined,
      chainId: 5115,
      initialBaseFeePerGas: 0,
      mining: {
        auto: true,
        interval: 0,
      },
    },
    citreaTestnet: {
      url: process.env.CITREA_RPC_URL || "https://rpc.testnet.citrea.xyz",
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 5115,
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
