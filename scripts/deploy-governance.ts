import { ethers } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Deploy JuiceSwapGovernor and transfer ownership from EOA to DAO
 */

// Configuration
const CITREA_RPC = 'https://rpc.citrea.xyz'
const CITREA_CHAIN_ID = 62831

// Addresses from deployment (from deploy-v3)
const STATE_FILE = path.join(__dirname, '../../deploy-v3/state.json')

// JUICE/JUSD addresses - must be set in environment
const JUSD_ADDRESS = process.env.JUSD_ADDRESS
const JUICE_ADDRESS = process.env.JUICE_ADDRESS

if (!JUSD_ADDRESS || !JUICE_ADDRESS) {
  throw new Error('JUSD_ADDRESS and JUICE_ADDRESS environment variables must be set')
}

async function main() {
  console.log('🏛️  Deploying JuiceSwap Governance')
  console.log('===================================\n')

  // Get signer from hardhat
  const [deployer] = await ethers.getSigners()

  console.log('📍 Deployer:', deployer.address)
  console.log('⛓️  Network: Citrea Mainnet')
  console.log('🔗 RPC:', CITREA_RPC)
  console.log('')

  // Load state.json to get deployed addresses
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  console.log('📦 Loaded JuiceSwap deployment state:')
  console.log('   Factory:', state.v3CoreFactoryAddress)
  console.log('   ProxyAdmin:', state.proxyAdminAddress)
  console.log('')

  console.log('🪙 JUICE/JUSD Integration:')
  console.log('   JUSD:', JUSD_ADDRESS)
  console.log('   JUICE:', JUICE_ADDRESS)
  console.log('')

  // Check balance
  const provider = ethers.provider
  const balance = await provider.getBalance(deployer.address)
  console.log('💰 Deployer Balance:', ethers.formatEther(balance), 'cBTC\n')

  // Step 1: Deploy JuiceSwapGovernor
  console.log('📝 Step 1: Deploying JuiceSwapGovernor...')

  const JuiceSwapGovernorFactory = await ethers.getContractFactory('JuiceSwapGovernor')

  const governor = await JuiceSwapGovernorFactory.deploy(
    JUSD_ADDRESS,
    JUICE_ADDRESS,
    {
      gasLimit: 2000000
    }
  )
  await governor.waitForDeployment()

  const governorAddress = await governor.getAddress()
  console.log('✅ JuiceSwapGovernor deployed at:', governorAddress)
  console.log('   Tx Hash:', governor.deploymentTransaction()?.hash)
  console.log('')

  // Step 1b: Deploy JuiceSwapFeeCollector
  console.log('📝 Step 1b: Deploying JuiceSwapFeeCollector...')

  // Get SwapRouter and Factory addresses from state.json
  const swapRouter = state.swapRouter02
  const factory = state.v3CoreFactoryAddress

  console.log('📦 SwapRouter:', swapRouter)
  console.log('📦 Factory:', factory)
  console.log('📦 Owner (Governor):', governorAddress)
  console.log('')

  const JuiceSwapFeeCollectorFactory = await ethers.getContractFactory('JuiceSwapFeeCollector')

  const feeCollector = await JuiceSwapFeeCollectorFactory.deploy(
    JUSD_ADDRESS,
    JUICE_ADDRESS,
    swapRouter,
    factory,
    governorAddress,  // Governor owns FeeCollector
    {
      gasLimit: 3000000
    }
  )
  await feeCollector.waitForDeployment()

  const feeCollectorAddress = await feeCollector.getAddress()
  console.log('✅ JuiceSwapFeeCollector deployed at:', feeCollectorAddress)
  console.log('   Tx Hash:', feeCollector.deploymentTransaction()?.hash)
  console.log('')

  // Step 2: Transfer Factory Ownership to Governor
  console.log('📝 Step 2: Transferring Factory ownership to Governor...')

  const factoryABI = [
    'function owner() view returns (address)',
    'function setOwner(address _owner)'
  ]
  const factoryContract = new ethers.Contract(state.v3CoreFactoryAddress, factoryABI, deployer)

  const currentFactoryOwner = await factoryContract.owner()
  console.log('   Current Factory Owner:', currentFactoryOwner)

  if (currentFactoryOwner !== deployer.address) {
    console.log('⚠️  Warning: Deployer is not Factory owner!')
    console.log('   You need to run this script with the current owner\'s private key\n')
  } else {
    const setOwnerTx = await factoryContract.setOwner(governorAddress, { gasLimit: 200000 })
    await setOwnerTx.wait()
    console.log('✅ Factory ownership transferred to Governor')
    console.log('   Tx Hash:', setOwnerTx.hash)
    console.log('')
  }

  // Step 3: Transfer ProxyAdmin Ownership to Governor
  console.log('📝 Step 3: Transferring ProxyAdmin ownership to Governor...')

  const proxyAdminABI = [
    'function owner() view returns (address)',
    'function transferOwnership(address newOwner)'
  ]
  const proxyAdmin = new ethers.Contract(state.proxyAdminAddress, proxyAdminABI, deployer)

  const currentProxyOwner = await proxyAdmin.owner()
  console.log('   Current ProxyAdmin Owner:', currentProxyOwner)

  if (currentProxyOwner !== deployer.address) {
    console.log('⚠️  Warning: Deployer is not ProxyAdmin owner!')
    console.log('   You need to run this script with the current owner\'s private key\n')
  } else {
    const transferOwnershipTx = await proxyAdmin.transferOwnership(governorAddress, { gasLimit: 200000 })
    await transferOwnershipTx.wait()
    console.log('✅ ProxyAdmin ownership transferred to Governor')
    console.log('   Tx Hash:', transferOwnershipTx.hash)
    console.log('')
  }

  // Step 4: Verify ownership transfer
  console.log('📝 Step 4: Verifying ownership transfer...\n')

  const newFactoryOwner = await factoryContract.owner()
  const newProxyOwner = await proxyAdmin.owner()

  console.log('🔍 Final Ownership:')
  console.log('   Factory Owner:', newFactoryOwner)
  console.log('   ProxyAdmin Owner:', newProxyOwner)
  console.log('   Governor Address:', governorAddress)
  console.log('   FeeCollector Owner:', await feeCollector.owner())
  console.log('')

  if (newFactoryOwner === governorAddress && newProxyOwner === governorAddress) {
    console.log('✅ All ownership successfully transferred to Governor!')
  } else {
    console.log('⚠️  Warning: Ownership transfer incomplete!')
  }

  // Save governance deployment info
  const governanceState = {
    governorAddress: governorAddress,
    feeCollectorAddress: feeCollectorAddress,
    jusdAddress: JUSD_ADDRESS,
    juiceAddress: JUICE_ADDRESS,
    factoryAddress: state.v3CoreFactoryAddress,
    proxyAdminAddress: state.proxyAdminAddress,
    swapRouterAddress: swapRouter,
    deployedAt: new Date().toISOString(),
    governorDeployTxHash: governor.deploymentTransaction()?.hash,
    feeCollectorDeployTxHash: feeCollector.deploymentTransaction()?.hash,
    network: 'Citrea Mainnet',
    chainId: CITREA_CHAIN_ID
  }

  const governanceFile = path.join(__dirname, '../governance-deployment.json')
  fs.writeFileSync(governanceFile, JSON.stringify(governanceState, null, 2))
  console.log('\n📄 Governance deployment info saved to:', governanceFile)

  // Print summary
  console.log('\n🎉 Governance Deployment Complete!')
  console.log('===================================\n')
  console.log('📊 Summary:')
  console.log('   Governor:', governorAddress)
  console.log('   FeeCollector:', feeCollectorAddress)
  console.log('   Factory:', state.v3CoreFactoryAddress)
  console.log('   ProxyAdmin:', state.proxyAdminAddress)
  console.log('')
  console.log('⚙️  Governance Parameters:')
  console.log('   Proposal Fee: 1000 JUSD (goes to JUICE equity)')
  console.log('   Application Period: 14 days minimum')
  console.log('   Veto Quorum: 2% of JUICE voting power')
  console.log('')
  console.log('🤖 Fee Collection:')
  console.log('   Fee Collector Contract:', feeCollectorAddress)
  console.log('   Keeper Address: Not set (use setFeeCollector proposal)')
  console.log('   Swap Router:', swapRouter)
  console.log('   TWAP Period: 30 minutes')
  console.log('   Max Slippage: 2%')
  console.log('   Frontrunning Protection: TWAP Oracle')
  console.log('')
  console.log('🔗 Explorer:')
  console.log(`   Governor: https://explorer.citrea.xyz/address/${governorAddress}`)
  console.log(`   FeeCollector: https://explorer.citrea.xyz/address/${feeCollectorAddress}`)
  console.log('')
  console.log('📘 Next Steps:')
  console.log('   1. Verify both contracts on explorer')
  console.log('   2. Create proposal to set fee collector keeper address')
  console.log('   3. Setup keeper bot with private RPC')
  console.log('   4. Announce governance transition to community')
  console.log('')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Error:', error)
    process.exit(1)
  })
