# JuiceSwap Gateway Deployment Guide

## Contract Addresses (Citrea Testnet - Chain ID: 5115)

### JuiceDollar Protocol
| Contract | Address |
|----------|---------|
| JUSD | `0x1Dd3057888944ff1f914626aB4BD47Dc8b6285Fe` |
| svJUSD (SavingsVaultJUSD) | `0x59b670e9fA9D0A427751Af201D676719a970857b` |
| JUICE (Equity) | `0xD82010E94737A4E4C3fc26314326Ff606E2Dcdf4` |

### Wrapped cBTC
| Contract | Address |
|----------|---------|
| WcBTC | `0x8d0c9d1c17aE5e40ffF9bE350f57840E9E66Cd93` |

### Uniswap V3 Fork (JuiceSwap)
| Contract | Address |
|----------|---------|
| SwapRouter02 | `0x610c98EAD0df13EA906854b6041122e8A8D14413` |
| NonfungiblePositionManager | `0xe46616BED47317653EE3B7794fC171F4444Ee1c5` |
| V3 Factory | `0x6832283eEA5a9A3C4384A5D9a06Db0ce6FE9C79E` |
| Multicall | `0x523A5dbC640Ed57b0Df84f1Df0a77f8AC32D194F` |
| Quoter | `0x8068F946D23B18Ab36Bc09A7DFF177b37525aB20` |

## Deployment Steps

### 1. Setup Environment

Create a `.env` file in the smart-contracts directory:

```bash
cp .env.example .env
```

Edit `.env` and add:

```env
# Deployment Configuration
CITREA_RPC_URL=https://rpc.testnet.citrea.xyz
DEPLOYER_PRIVATE_KEY=your_private_key_here

# JuiceDollar Protocol Addresses
JUSD_ADDRESS=0x1Dd3057888944ff1f914626aB4BD47Dc8b6285Fe
SV_JUSD_ADDRESS=0x59b670e9fA9D0A427751Af201D676719a970857b
JUICE_ADDRESS=0xD82010E94737A4E4C3fc26314326Ff606E2Dcdf4

# Wrapped cBTC Address
WCBTC_ADDRESS=0x8d0c9d1c17aE5e40ffF9bE350f57840E9E66Cd93

# Uniswap V3 Fork Addresses
SWAP_ROUTER_ADDRESS=0x610c98EAD0df13EA906854b6041122e8A8D14413
POSITION_MANAGER_ADDRESS=0xe46616BED47317653EE3B7794fC171F4444Ee1c5
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Compile Contracts

```bash
npm run compile
```

### 4. Deploy to Citrea Testnet

```bash
npx hardhat run scripts/deployJuiceSwapGateway.ts --network citreaTestnet
```

The script will:
1. ✅ Validate all contract addresses
2. ✅ Deploy the JuiceSwapGateway contract
3. ✅ Wait for 5 block confirmations
4. ✅ Automatically verify the contract on the block explorer
5. ✅ Output the deployed gateway address

### 5. Save Deployed Address

After deployment, add the gateway address to your `.env`:

```env
JUICESWAP_GATEWAY_ADDRESS=<deployed_address_from_output>
```

## Manual Verification (if needed)

If automatic verification fails, you can verify manually:

```bash
npx hardhat verify --network citreaTestnet <GATEWAY_ADDRESS> \
  0x1Dd3057888944ff1f914626aB4BD47Dc8b6285Fe \
  0x59b670e9fA9D0A427751Af201D676719a970857b \
  0xD82010E94737A4E4C3fc26314326Ff606E2Dcdf4 \
  0x8d0c9d1c17aE5e40ffF9bE350f57840E9E66Cd93 \
  0x610c98EAD0df13EA906854b6041122e8A8D14413 \
  0xe46616BED47317653EE3B7794fC171F4444Ee1c5
```

## Testing the Gateway

After deployment, you can test the gateway functions:

### Swap JUSD for another token
```typescript
const gateway = await ethers.getContractAt("JuiceSwapGateway", GATEWAY_ADDRESS);
await gateway.swapExactTokensForTokens(
  JUSD_ADDRESS,        // tokenIn
  OTHER_TOKEN_ADDRESS, // tokenOut
  amountIn,
  minAmountOut,
  recipientAddress,
  deadline
);
```

### Add Liquidity (full-range position)
```typescript
await gateway.addLiquidity(
  JUSD_ADDRESS,        // tokenA
  OTHER_TOKEN_ADDRESS, // tokenB
  amountADesired,
  amountBDesired,
  amountAMin,
  amountBMin,
  recipientAddress,
  deadline
);
```

## Architecture Overview

The JuiceSwapGateway acts as an abstraction layer that:

1. **Automatically converts tokens:**
   - JUSD → svJUSD (interest-bearing)
   - JUICE → JUSD → svJUSD (via Equity contract)
   - cBTC → WcBTC (wrapped)

2. **Routes through Uniswap V3:**
   - Uses SwapRouter02 for swaps
   - Uses NonfungiblePositionManager for liquidity positions

3. **Hides complexity from users:**
   - Frontend always displays JUSD
   - Users earn both swap fees + savings interest
   - All conversions happen transparently

## Security Features

- ✅ ReentrancyGuard on all state-changing functions
- ✅ Pausable for emergency stops
- ✅ Ownable with rescue functions
- ✅ Rejects direct native token transfers
- ✅ Pre-approved tokens for gas efficiency

## Support

For issues or questions:
- GitHub: https://github.com/JuiceSwapxyz
- Explorer: https://explorer.testnet.citrea.xyz
