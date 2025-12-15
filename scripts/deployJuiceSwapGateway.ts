import { ethers, run, network } from "hardhat";

async function main() {
  console.log(`🚀 Deploying JuiceSwapGateway to ${network.name}...\n`);

  const [deployer] = await ethers.getSigners();
  console.log("👤 Deployer:", deployer.address);
  console.log("💰 Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH/cBTC\n");

  // 1. LOAD & VALIDATE ADDRESSES
  const {
    JUSD_ADDRESS,
    SV_JUSD_ADDRESS,
    JUICE_ADDRESS,
    WCBTC_ADDRESS,
    SWAP_ROUTER_ADDRESS,
    POSITION_MANAGER_ADDRESS
  } = process.env;

  if (!JUSD_ADDRESS || !SV_JUSD_ADDRESS || !JUICE_ADDRESS || !WCBTC_ADDRESS || !SWAP_ROUTER_ADDRESS || !POSITION_MANAGER_ADDRESS) {
    throw new Error("❌ Missing environment variables in .env file!");
  }

  const args = [
    JUSD_ADDRESS,
    SV_JUSD_ADDRESS,
    JUICE_ADDRESS,
    WCBTC_ADDRESS,
    SWAP_ROUTER_ADDRESS,
    POSITION_MANAGER_ADDRESS
  ];

  console.log("📋 Configuration:");
  console.log(`  JUSD:            ${JUSD_ADDRESS}`);
  console.log(`  svJUSD:          ${SV_JUSD_ADDRESS}`);
  console.log(`  JUICE:           ${JUICE_ADDRESS}`);
  console.log(`  WcBTC:           ${WCBTC_ADDRESS}`);
  console.log(`  SwapRouter:      ${SWAP_ROUTER_ADDRESS}`);
  console.log(`  PosManager:      ${POSITION_MANAGER_ADDRESS}\n`);

  // 2. DEPLOY
  console.log("⏳ Deploying contract...");
  const JuiceSwapGateway = await ethers.getContractFactory("JuiceSwapGateway");
  const gateway = await JuiceSwapGateway.deploy(...args);

  await gateway.waitForDeployment();
  const gatewayAddress = await gateway.getAddress();

  console.log(`✅ Deployed to: ${gatewayAddress}`);

  // 3. VALIDATE DEPLOYMENT
  console.log("\n🔍 Validating deployment...");
  const defaultFee = await gateway.defaultFee();
  const owner = await gateway.owner();
  const isPaused = await gateway.paused();
  const factory = await gateway.FACTORY();

  console.log(`  Default Fee: ${defaultFee} (${defaultFee === 3000n ? '0.3%' : 'custom'})`);
  console.log(`  Owner: ${owner}`);
  console.log(`  Paused: ${isPaused}`);
  console.log(`  Factory: ${factory}`);

  if (owner !== deployer.address) {
    console.log("  ⚠️  Warning: Owner is not deployer!");
  }
  if (isPaused) {
    console.log("  ⚠️  Warning: Contract is paused!");
  }

  // 4. VERIFICATION INSTRUCTIONS
  console.log("\n📋 To verify contract on explorer:");
  console.log(`npx hardhat verify --network ${network.name} ${gatewayAddress} ${args.join(" ")}`);

  console.log("\n✨ Deployment complete!");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});