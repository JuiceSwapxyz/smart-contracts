import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
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
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },
  etherscan: {
    apiKey: {
      citreaTestnet: "no-api-key-needed",
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
    ],
  },
  sourcify: {
    enabled: true,
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
