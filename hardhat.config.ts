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
    },
    customChains: [
      {
        network: "citreaTestnet",
        chainId: 5115,
        urls: {
          apiURL: "https://explorer.testnet.citrea.xyz/api",
          browserURL: "https://explorer.testnet.citrea.xyz",
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
