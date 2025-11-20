import { ethers } from "hardhat";

async function main() {
  console.log("🚀 Deploying JuiceSwapGateway...\n");

  // Get deployer account
  const [deployer] = await ethers.getSigners();
  console.log("Deployer address:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer balance:", ethers.formatEther(balance), "cBTC\n");

  // Contract addresses - from environment variables
  const JUSD_ADDRESS = process.env.JUSD_ADDRESS;
  const SV_JUSD_ADDRESS = process.env.SV_JUSD_ADDRESS;
  const JUICE_ADDRESS = process.env.JUICE_ADDRESS;
  const WCBTC_ADDRESS = process.env.WCBTC_ADDRESS;
  const SWAP_ROUTER_ADDRESS = process.env.SWAP_ROUTER_ADDRESS;
  const POSITION_MANAGER_ADDRESS = process.env.POSITION_MANAGER_ADDRESS;

  // Validate addresses
  if (!JUSD_ADDRESS || !SV_JUSD_ADDRESS || !JUICE_ADDRESS ||
      !WCBTC_ADDRESS || !SWAP_ROUTER_ADDRESS || !POSITION_MANAGER_ADDRESS) {
    throw new Error(
      "❌ Missing required environment variables. Please set:\n" +
      "  - JUSD_ADDRESS\n" +
      "  - SV_JUSD_ADDRESS\n" +
      "  - JUICE_ADDRESS\n" +
      "  - WCBTC_ADDRESS\n" +
      "  - SWAP_ROUTER_ADDRESS\n" +
      "  - POSITION_MANAGER_ADDRESS"
    );
  }

  console.log("📋 Contract Addresses:");
  console.log("├─ JUSD:               ", JUSD_ADDRESS);
  console.log("├─ svJUSD:             ", SV_JUSD_ADDRESS);
  console.log("├─ JUICE:              ", JUICE_ADDRESS);
  console.log("├─ WcBTC:              ", WCBTC_ADDRESS);
  console.log("├─ SwapRouter:         ", SWAP_ROUTER_ADDRESS);
  console.log("└─ PositionManager:    ", POSITION_MANAGER_ADDRESS);
  console.log();

  // Deploy JuiceSwapGateway
  console.log("⏳ Deploying JuiceSwapGateway contract...");

  const JuiceSwapGateway = await ethers.getContractFactory("JuiceSwapGateway");
  const gateway = await JuiceSwapGateway.deploy(
    JUSD_ADDRESS,
    SV_JUSD_ADDRESS,
    JUICE_ADDRESS,
    WCBTC_ADDRESS,
    SWAP_ROUTER_ADDRESS,
    POSITION_MANAGER_ADDRESS
  );

  await gateway.waitForDeployment();
  const gatewayAddress = await gateway.getAddress();

  console.log("✅ JuiceSwapGateway deployed to:", gatewayAddress);
  console.log();

  // Wait for block confirmations before verification
  console.log("⏳ Waiting for 5 block confirmations...");
  await gateway.deploymentTransaction()?.wait(5);
  console.log("✅ Confirmations complete\n");

  // Get deployment transaction details
  const deployTx = gateway.deploymentTransaction();
  if (deployTx) {
    console.log("📊 Deployment Details:");
    console.log("├─ Transaction Hash:", deployTx.hash);
    console.log("├─ Block Number:    ", deployTx.blockNumber);
    console.log("└─ Gas Used:        ", deployTx.gasLimit.toString());
    console.log();
  }

  // Output useful information
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📝 Add this to your .env file:");
  console.log(`JUICESWAP_GATEWAY_ADDRESS=${gatewayAddress}`);
  console.log();

  console.log("🔍 Verification command:");
  const network = process.env.HARDHAT_NETWORK || 'citreaTestnet';
  console.log(`npx hardhat verify --network ${network} ${gatewayAddress} \\`);
  console.log(`  ${JUSD_ADDRESS} \\`);
  console.log(`  ${SV_JUSD_ADDRESS} \\`);
  console.log(`  ${JUICE_ADDRESS} \\`);
  console.log(`  ${WCBTC_ADDRESS} \\`);
  console.log(`  ${SWAP_ROUTER_ADDRESS} \\`);
  console.log(`  ${POSITION_MANAGER_ADDRESS}`);
  console.log();

  console.log("🌐 View on Explorer:");
  console.log(`https://explorer.testnet.citrea.xyz/address/${gatewayAddress}`);
  console.log();

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("✨ Deployment complete!");
  console.log();

  // Optional: Verify contract if not on local network
  if (network !== 'hardhat' && network !== 'localhost') {
    console.log("⏳ Verifying contract on block explorer...");
    try {
      await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10s for indexer

      await (await import("hardhat")).run("verify:verify", {
        address: gatewayAddress,
        constructorArguments: [
          JUSD_ADDRESS,
          SV_JUSD_ADDRESS,
          JUICE_ADDRESS,
          WCBTC_ADDRESS,
          SWAP_ROUTER_ADDRESS,
          POSITION_MANAGER_ADDRESS,
        ],
      });
      console.log("✅ Contract verified!");
    } catch (error: any) {
      if (error.message.includes("already verified")) {
        console.log("✅ Contract already verified!");
      } else {
        console.log("⚠️  Verification failed (you can verify manually later):");
        console.log(error.message);
      }
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed:");
    console.error(error);
    process.exit(1);
  });
