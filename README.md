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
- **Proposal fee**: 1000 JUSD (sent to JUICE equity, increasing JUICE price)
- **Veto period**: 14 days for community review
- **Quorum**: 2% voting power required to veto
- **Holding-weighted votes**: Longer JUICE holders have more voting power
- **Separation**: Governance-only contract (fee collection in separate contract)

**Details:**
- **Contract**: `contracts/governance/JuiceSwapGovernor.sol`
- **Network**: Citrea Mainnet (Chain ID: 62831)
- **Controls**: Factory, ProxyAdmin, FeeCollector
- **Size**: ~320 lines

**Integration:**
- **JUSD**: JuiceDollar stablecoin (proposal fee payment → equity)
- **JUICE**: Equity token (voting power source)

**Governance Process:**
1. Anyone pays 1000 JUSD to create proposal (goes directly to JUICE equity)
2. 14 day veto period begins
3. JUICE holders with 2%+ voting power can veto
4. If no veto, anyone can execute proposal

---

### JuiceSwapFeeCollector

Automated protocol fee collection contract for JuiceSwap, owned and controlled by JuiceSwapGovernor.

**Features:**
- **Automated fee collection**: Collects protocol fees from Uniswap V3 pools
- **TWAP-based protection**: Uses 30-minute TWAP oracle to prevent frontrunning
- **Slippage protection**: Maximum 2% slippage on swaps
- **Multi-hop swaps**: Supports complex swap paths to JUSD
- **Fee destination**: All collected fees converted to JUSD and sent to JUICE equity
- **Governance-controlled**: Only owner (Governor) can update settings

**Details:**
- **Contract**: `contracts/governance/JuiceSwapFeeCollector.sol`
- **Owner**: JuiceSwapGovernor (controlled via proposals)
- **Keeper**: Authorized address that can trigger fee collection
- **Size**: ~380 lines

**Security:**
- Uses Uniswap's official TickMath library
- SafeERC20 for non-standard token compatibility
- ReentrancyGuard protection
- Path validation (ensures swaps end with JUSD)
- TWAP oracle prevents price manipulation

**Configuration:**
- **TWAP Period**: 30 minutes
- **Max Slippage**: 2% (in basis points)
- **SwapRouter**: Configurable via governance
- **Keeper**: Configurable via governance

---

#### Deploy Governance

```bash
# Configure environment
export PRIVATE_KEY="..."        # Current Factory/ProxyAdmin owner
export JUSD_ADDRESS="..."       # JuiceDollar contract
export JUICE_ADDRESS="..."      # Equity contract

# Deploy both contracts and transfer ownership
npx ts-node scripts/deploy-governance.ts
```

This will:
1. Deploy JuiceSwapGovernor contract
2. Deploy JuiceSwapFeeCollector contract (Governor is owner)
3. Transfer Factory ownership to Governor
4. Transfer ProxyAdmin ownership to Governor
5. Save deployment info to `governance-deployment.json`

**Post-Deployment:**
To enable fee collection, create a governance proposal to set the keeper address:

```typescript
// Create proposal to set fee collector keeper
const feeCollectorAddress = "0x..."; // From governance-deployment.json
const keeperAddress = "0x...";        // Your keeper bot address

const data = governor.encodeSetFeeCollector(keeperAddress);
await governor.propose(
  feeCollectorAddress,
  data,
  14 * 24 * 60 * 60, // 14 days
  "Set fee collector keeper address"
);
```

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
