import { ethers } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Deploy JuiceSwapGovernor and transfer ownership from EOA to DAO
 */

// Validate all required addresses
if (!process.env.JUSD_ADDRESS || !process.env.JUICE_ADDRESS || !process.env.FACTORY_ADDRESS || !process.env.SWAP_ROUTER_ADDRESS || !process.env.PROXY_ADMIN_ADDRESS) {
  throw new Error('All governance addresses must be set in .env: JUSD_ADDRESS, JUICE_ADDRESS, FACTORY_ADDRESS, SWAP_ROUTER_ADDRESS, PROXY_ADMIN_ADDRESS')
}

// Now TypeScript knows these are defined
const JUSD_ADDRESS = process.env.JUSD_ADDRESS
const JUICE_ADDRESS = process.env.JUICE_ADDRESS
const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS
const SWAP_ROUTER_ADDRESS = process.env.SWAP_ROUTER_ADDRESS
const PROXY_ADMIN_ADDRESS = process.env.PROXY_ADMIN_ADDRESS

async function main() {
  console.log('🏛️  Deploying JuiceSwap Governance')
  console.log('===================================\n')

  // Get signer and network info
  const [deployer] = await ethers.getSigners()
  const network = await ethers.provider.getNetwork()

  // Network configuration mapping
  const NETWORK_CONFIG: Record<string, { name: string; folder: string }> = {
    '5115': { name: 'Citrea Testnet', folder: 'testnet' },
    '62831': { name: 'Citrea Mainnet', folder: 'mainnet' },
  }

  const chainIdStr = network.chainId.toString()
  const { name: networkName, folder: deploymentFolder } =
    NETWORK_CONFIG[chainIdStr] || { name: 'Localhost', folder: 'localhost' }

  console.log('📍 Deployer:', deployer.address)
  console.log('⛓️  Network:', networkName, `(Chain ID: ${network.chainId})`)
  console.log('')

  console.log('📦 V3 Contracts:')
  console.log('   Factory:', FACTORY_ADDRESS)
  console.log('   SwapRouter:', SWAP_ROUTER_ADDRESS)
  console.log('   ProxyAdmin:', PROXY_ADMIN_ADDRESS)
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

  const JuiceSwapFeeCollectorFactory = await ethers.getContractFactory('JuiceSwapFeeCollector')

  const feeCollector = await JuiceSwapFeeCollectorFactory.deploy(
    JUSD_ADDRESS,
    JUICE_ADDRESS,
    SWAP_ROUTER_ADDRESS,
    FACTORY_ADDRESS,
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
  const factoryContract = new ethers.Contract(FACTORY_ADDRESS, factoryABI, deployer)

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
  const proxyAdmin = new ethers.Contract(PROXY_ADMIN_ADDRESS, proxyAdminABI, deployer)

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

  // Save governance deployment info using standard schema
  const blockNumber = await ethers.provider.getBlockNumber()
  const governanceState = {
    schemaVersion: '1.0',
    network: {
      name: networkName,
      chainId: Number(network.chainId)
    },
    deployment: {
      deployedAt: new Date().toISOString(),
      deployedBy: deployer.address,
      blockNumber: blockNumber
    },
    contracts: {
      JuiceSwapGovernor: {
        address: governorAddress,
        deploymentTx: governor.deploymentTransaction()?.hash,
        constructorArgs: [JUSD_ADDRESS, JUICE_ADDRESS]
      },
      JuiceSwapFeeCollector: {
        address: feeCollectorAddress,
        deploymentTx: feeCollector.deploymentTransaction()?.hash,
        constructorArgs: [JUSD_ADDRESS, JUICE_ADDRESS, SWAP_ROUTER_ADDRESS, FACTORY_ADDRESS, governorAddress]
      }
    },
    references: {
      jusdAddress: JUSD_ADDRESS,
      juiceAddress: JUICE_ADDRESS,
      factoryAddress: FACTORY_ADDRESS,
      proxyAdminAddress: PROXY_ADMIN_ADDRESS,
      swapRouterAddress: SWAP_ROUTER_ADDRESS
    },
    metadata: {
      deployer: 'JuiceSwapXyz/smart-contracts',
      scriptVersion: '1.0.0'
    }
  }

  // Save to deployments directory
  const deployDir = path.join(__dirname, '../deployments', deploymentFolder)
  fs.mkdirSync(deployDir, { recursive: true })
  const governanceFile = path.join(deployDir, 'governance.json')
  fs.writeFileSync(governanceFile, JSON.stringify(governanceState, null, 2))
  console.log('\n📄 Governance deployment info saved to:', governanceFile)

  // Print summary
  console.log('\n🎉 Governance Deployment Complete!')
  console.log('===================================\n')
  console.log('📊 Summary:')
  console.log('   Governor:', governorAddress)
  console.log('   FeeCollector:', feeCollectorAddress)
  console.log('   Factory:', FACTORY_ADDRESS)
  console.log('   ProxyAdmin:', PROXY_ADMIN_ADDRESS)
  console.log('')
  console.log('⚙️  Governance Parameters:')
  console.log('   Proposal Fee: 1000 JUSD (goes to JUICE equity)')
  console.log('   Application Period: 14 days minimum')
  console.log('   Veto Quorum: 2% of JUICE voting power')
  console.log('')
  console.log('🤖 Fee Collection:')
  console.log('   Fee Collector Contract:', feeCollectorAddress)
  console.log('   Keeper Address: Not set (use setFeeCollector proposal)')
  console.log('   Swap Router:', SWAP_ROUTER_ADDRESS)
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
