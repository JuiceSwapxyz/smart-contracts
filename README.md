# JuiceSwap Smart Contracts

Smart contract infrastructure for JuiceSwap protocol on Citrea.

## Quick Start

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Add required variables (see .env.example)

# Compile contracts
npm run compile

# Run tests
npm test
```

## Contracts

### JuiceSwapGovernor

Decentralized governance contract for JuiceSwap protocol, integrating with JUICE/JUSD veto system.

**Features:**
- **Community-controlled**: JUICE token holders govern JuiceSwap
- **Proposal fee**: 1000 JUSD to prevent spam
- **Veto period**: 14 days for community review
- **Quorum**: 2% voting power required to veto
- **Holding-weighted votes**: Longer JUICE holders have more voting power

**Details:**
- **Contract**: `contracts/governance/JuiceSwapGovernor.sol`
- **Network**: Citrea Mainnet (Chain ID: 62831)
- **Controls**: Factory (`0x6832283eEA5a9A3C4384A5D9a06Db0ce6FE9C79E`), ProxyAdmin (`0x3F7a8cC3722fCad90040466EC2CfB618054f5e62`)

**Integration:**
- **JUSD**: JuiceDollar stablecoin (proposal fee payment)
- **JUICE**: Equity token (voting power)

#### Deploy Governance

```bash
# Configure environment
export PRIVATE_KEY="..."        # Current Factory/ProxyAdmin owner
export JUSD_ADDRESS="..."       # JuiceDollar contract
export JUICE_ADDRESS="..."      # Equity contract

# Deploy and transfer ownership
npx ts-node scripts/deploy-governance.ts
```

This will:
1. Deploy JuiceSwapGovernor contract
2. Transfer Factory ownership to Governor
3. Transfer ProxyAdmin ownership to Governor
4. Save deployment info to `governance-deployment.json`

**Governance Process:**
1. Anyone pays 1000 JUSD to create proposal
2. 14 day veto period begins
3. JUICE holders with 2%+ voting power can veto
4. If no veto, anyone can execute proposal

---

### FirstSqueezerNFT

Campaign NFT contract for early JuiceSwap supporters.

**Features:**
- **One mint per address**: Users can only claim once
- **Deadline enforcement**: Campaign ends October 31, 2025
- **Signature-based claiming**: Backend API verifies campaign completion
- **Direct minting**: NFT minted directly to user wallet
- **Static metadata**: All tokens share same IPFS metadata

**Details:**
- **Contract**: `contracts/FirstSqueezerNFT.sol`
- **Network**: Citrea Testnet (Chain ID: 5115)
- **Standard**: ERC-721
- **Campaign End**: October 31, 2025 23:59:59 UTC

#### Deploy First Squeezer

One command from image to deployed contract:

```bash
# Local testing (Hardhat network)
hardhat create-nft --image "/path/to/your/image.jpeg"

# Production deployment (Citrea Testnet)
hardhat create-nft --network citreaTestnet --image "/path/to/your/image.jpeg"
```

This will:
1. Upload image to IPFS (Pinata)
2. Generate + upload metadata to IPFS
3. Deploy contract to specified network
4. Verify contract on block explorer (production only)
5. Output contract address for your API

**Environment Variables:**
- `PINATA_JWT` - JWT token from [pinata.cloud](https://app.pinata.cloud/developers/api-keys) (enable pinFileToIPFS and pinJSONToIPFS permissions)
- `DEPLOYER_PRIVATE_KEY` - Wallet private key (must have cBTC for gas)
- `CAMPAIGN_SIGNER_ADDRESS` - Backend API signer address (public address, not private key)

**Post-Deployment:**

Add contract address to API `.env`:
```bash
FIRST_SQUEEZER_NFT_CONTRACT=0x...  # Copy from deployment output
```

#### Architecture

**Claim Flow:**
1. User completes Twitter + Discord verification
2. API generates signature for eligible user
3. User calls `contract.claim(signature)` (pays gas)
4. Contract verifies signature from trusted signer
5. NFT minted directly to user

**Security:**
- Signature verification using ECDSA
- One-time claiming enforced by mapping
- Immutable signer address (set at deployment)
- Hardcoded deadline (no admin control)
- CEI pattern (reentrancy safe)

## Development

### Testing

Run the comprehensive test suite:

```bash
# Test on clean Hardhat network
npm test

# Test on local Citrea Testnet fork
FORK_CITREA=true npm test
```

**Test Coverage:**
- Deployment & initialization
- Signature-based claiming
- Security (reentrancy, replay attacks)
- Campaign deadline enforcement
- Static metadata (tokenURI)
- ERC-721 compliance

### Network Configuration

**Citrea Testnet:**
- Chain ID: 5115
- RPC: https://rpc.testnet.citrea.xyz
- Native Token: cBTC (testnet Bitcoin)

## License

MIT
