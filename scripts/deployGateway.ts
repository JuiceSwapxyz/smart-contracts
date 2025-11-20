import { ethers } from "hardhat";

async function main() {
  console.log("🚀 Deploying JuiceSwapGateway to Citrea Testnet...\n");

  // Citrea Testnet addresses
  const JUSD = "0x1Dd3057888944ff1f914626aB4BD47Dc8b6285Fe";
  const SV_JUSD = "0x59b670e9fA9D0A427751Af201D676719a970857b";
  const JUICE = "0xD82010E94737A4E4C3fc26314326Ff606E2Dcdf4";
  const WCBTC = "0x8d0c9d1c17aE5e40ffF9bE350f57840E9E66Cd93";
  const SWAP_ROUTER = "0x610c98EAD0df13EA906854b6041122e8A8D14413";
  const POSITION_MANAGER = "0xe46616BED47317653EE3B7794fC171F4444Ee1c5";

  console.log("📋 Contract Addresses:");
  console.log("  JUSD:", JUSD);
  console.log("  svJUSD:", SV_JUSD);
  console.log("  JUICE:", JUICE);
  console.log("  WcBTC:", WCBTC);
  console.log("  SwapRouter:", SWAP_ROUTER);
  console.log("  PositionManager:", POSITION_MANAGER);
  console.log();

  // Get deployer
  const [deployer] = await ethers.getSigners();
  console.log("👤 Deploying from:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("💰 Deployer balance:", ethers.formatEther(balance), "cBTC");
  console.log();

  // Deploy Gateway
  console.log("⏳ Deploying JuiceSwapGateway...");
  const JuiceSwapGateway = await ethers.getContractFactory("JuiceSwapGateway");
  const gateway = await JuiceSwapGateway.deploy(
    JUSD,
    SV_JUSD,
    JUICE,
    WCBTC,
    SWAP_ROUTER,
    POSITION_MANAGER
  );

  await gateway.waitForDeployment();
  const gatewayAddress = await gateway.getAddress();

  console.log("✅ JuiceSwapGateway deployed to:", gatewayAddress);
  console.log();

  // Verify deployment
  console.log("🔍 Verifying deployment...");
  const defaultFee = await gateway.defaultFee();
  const owner = await gateway.owner();
  const paused = await gateway.paused();

  console.log("  Default Fee:", defaultFee.toString(), "(0.3%)");
  console.log("  Owner:", owner);
  console.log("  Paused:", paused);
  console.log();

  // Save deployment info
  const deploymentInfo = {
    network: "citreaTestnet",
    chainId: 5115,
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      JuiceSwapGateway: gatewayAddress,
      JUSD,
      SV_JUSD,
      JUICE,
      WCBTC,
      SWAP_ROUTER,
      POSITION_MANAGER,
    },
  };

  console.log("📝 Deployment Summary:");
  console.log(JSON.stringify(deploymentInfo, null, 2));
  console.log();

  console.log("✨ Deployment complete!");
  console.log();
  console.log("📌 Next steps:");
  console.log("  1. Verify contract on explorer:");
  console.log(`     npx hardhat verify --network citreaTestnet ${gatewayAddress} ${JUSD} ${SV_JUSD} ${JUICE} ${WCBTC} ${SWAP_ROUTER} ${POSITION_MANAGER}`);
  console.log();
  console.log("  2. Test the contract:");
  console.log(`     - Gateway Address: ${gatewayAddress}`);
  console.log("     - Try a swap on the frontend");
  console.log("     - Add liquidity");
  console.log();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
