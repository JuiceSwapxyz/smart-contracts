# First Squeezer NFT - Smart Contracts

Campaign NFT contract for early JuiceSwap supporters on Citrea Testnet.

## Features

- **One mint per address**: Users can only claim once
- **Deadline enforcement**: Campaign ends October 31, 2025
- **Signature-based claiming**: Backend API verifies campaign completion
- **Direct minting**: NFT minted directly to user wallet
- **Static metadata**: All tokens share same IPFS metadata

## Quick Start

**One command from image to deployed contract:**

```bash
# 1. Install dependencies
npm install

# 2. Configure .env (see .env.example)
cp .env.example .env
# Add: PINATA_API_KEY, PINATA_SECRET, DEPLOYER_PRIVATE_KEY, CAMPAIGN_SIGNER_ADDRESS

# 3. Create and deploy NFT contract
npm run create-nft -- "/path/to/your/image.jpeg"
```

**That's it!** The script will:
1. Upload image to IPFS (Pinata)
2. Generate + upload metadata to IPFS
3. Deploy contract to Citrea Testnet
4. Output contract address for your API

### Environment Variables

Required in `.env`:
- `PINATA_API_KEY` - Get at [pinata.cloud](https://app.pinata.cloud/developers/api-keys) (free tier)
- `PINATA_SECRET` - Pinata API secret
- `DEPLOYER_PRIVATE_KEY` - Wallet private key (must have cBTC for gas)
- `CAMPAIGN_SIGNER_ADDRESS` - Backend API signer address (for signature verification)

### Post-Deployment

Add contract address to API `.env`:
```bash
FIRST_SQUEEZER_NFT_CONTRACT=0x...  # Copy from deployment output
```

## Contract Details

- **Name**: First Squeezer
- **Symbol**: SQUEEZER
- **Network**: Citrea Testnet (Chain ID: 5115)
- **Standard**: ERC-721
- **Campaign End**: October 31, 2025 23:59:59 UTC

## Architecture

### Claim Flow
1. User completes Twitter + Discord verification
2. API generates signature for eligible user
3. User calls `contract.claim(signature)`
4. Contract verifies signature from trusted signer
5. NFT minted directly to user

### Security
- Signature verification using ECDSA
- One-time claiming enforced by mapping
- Immutable signer address (set at deployment)
- Hardcoded deadline (no admin control)
