import { ethers } from 'ethers'
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

// JUICE/JUSD addresses (replace with actual addresses)
const JUSD_ADDRESS = process.env.JUSD_ADDRESS || '0x...' // Replace with actual JUSD address
const JUICE_ADDRESS = process.env.JUICE_ADDRESS || '0x...' // Replace with actual JUICE (Equity) address

async function main() {
  console.log('🏛️  Deploying JuiceSwap Governance')
  console.log('===================================\n')

  // Load private key from environment
  const PRIVATE_KEY = process.env.PRIVATE_KEY
  if (!PRIVATE_KEY) {
    throw new Error('PRIVATE_KEY environment variable not set')
  }

  // Connect to network
  const provider = new ethers.providers.JsonRpcProvider(CITREA_RPC, CITREA_CHAIN_ID)
  const deployer = new ethers.Wallet(PRIVATE_KEY, provider)

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
  const balance = await provider.getBalance(deployer.address)
  console.log('💰 Deployer Balance:', ethers.utils.formatEther(balance), 'cBTC\n')

  // Step 1: Deploy JuiceSwapGovernor
  console.log('📝 Step 1: Deploying JuiceSwapGovernor...')

  // Load contract artifacts
  const JuiceSwapGovernorFactory = await ethers.getContractFactory('JuiceSwapGovernor', deployer)

  const governor = await JuiceSwapGovernorFactory.deploy(JUSD_ADDRESS, JUICE_ADDRESS, {
    gasLimit: 3000000
  })
  await governor.deployed()

  console.log('✅ JuiceSwapGovernor deployed at:', governor.address)
  console.log('   Tx Hash:', governor.deployTransaction.hash)
  console.log('')

  // Step 2: Transfer Factory Ownership to Governor
  console.log('📝 Step 2: Transferring Factory ownership to Governor...')

  const factoryABI = [
    'function owner() view returns (address)',
    'function setOwner(address _owner)'
  ]
  const factory = new ethers.Contract(state.v3CoreFactoryAddress, factoryABI, deployer)

  const currentFactoryOwner = await factory.owner()
  console.log('   Current Factory Owner:', currentFactoryOwner)

  if (currentFactoryOwner !== deployer.address) {
    console.log('⚠️  Warning: Deployer is not Factory owner!')
    console.log('   You need to run this script with the current owner\'s private key\n')
  } else {
    const setOwnerTx = await factory.setOwner(governor.address, { gasLimit: 200000 })
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
    const transferOwnershipTx = await proxyAdmin.transferOwnership(governor.address, { gasLimit: 200000 })
    await transferOwnershipTx.wait()
    console.log('✅ ProxyAdmin ownership transferred to Governor')
    console.log('   Tx Hash:', transferOwnershipTx.hash)
    console.log('')
  }

  // Step 4: Verify ownership transfer
  console.log('📝 Step 4: Verifying ownership transfer...\n')

  const newFactoryOwner = await factory.owner()
  const newProxyOwner = await proxyAdmin.owner()

  console.log('🔍 Final Ownership:')
  console.log('   Factory Owner:', newFactoryOwner)
  console.log('   ProxyAdmin Owner:', newProxyOwner)
  console.log('   Governor Address:', governor.address)
  console.log('')

  if (newFactoryOwner === governor.address && newProxyOwner === governor.address) {
    console.log('✅ All ownership successfully transferred to Governor!')
  } else {
    console.log('⚠️  Warning: Ownership transfer incomplete!')
  }

  // Save governance deployment info
  const governanceState = {
    governorAddress: governor.address,
    jusdAddress: JUSD_ADDRESS,
    juiceAddress: JUICE_ADDRESS,
    factoryAddress: state.v3CoreFactoryAddress,
    proxyAdminAddress: state.proxyAdminAddress,
    deployedAt: new Date().toISOString(),
    deployTxHash: governor.deployTransaction.hash,
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
  console.log('   Governor:', governor.address)
  console.log('   Factory:', state.v3CoreFactoryAddress)
  console.log('   ProxyAdmin:', state.proxyAdminAddress)
  console.log('')
  console.log('⚙️  Governance Parameters:')
  console.log('   Proposal Fee: 1000 JUSD')
  console.log('   Application Period: 14 days minimum')
  console.log('   Veto Quorum: 2% of JUICE voting power')
  console.log('')
  console.log('🔗 Explorer:')
  console.log(`   https://explorer.citrea.xyz/address/${governor.address}`)
  console.log('')
  console.log('📘 Next Steps:')
  console.log('   1. Verify Governor contract on explorer')
  console.log('   2. Test proposal creation with propose()')
  console.log('   3. Announce governance transition to community')
  console.log('')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Error:', error)
    process.exit(1)
  })
