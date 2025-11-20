# JuiceSwapGateway Test Suite

Comprehensive test suite for the JuiceSwapGateway contract covering all functionality, edge cases, and security concerns.

## Test Structure

### 1. **Deployment Tests**
- ✅ Verifies correct initialization of immutable addresses
- ✅ Checks default fee tier (0.3%)
- ✅ Validates owner assignment
- ✅ Ensures contract is not paused on deployment

### 2. **Token Conversion View Functions**
Tests all conversion helper functions:
- ✅ `jusdToSvJusd()` - JUSD to svJUSD share calculation
- ✅ `svJusdToJusd()` - svJUSD to JUSD asset calculation
- ✅ `juiceToJusd()` - JUICE redemption proceeds
- ✅ `jusdToJuice()` - JUICE investment shares

### 3. **Swap Tests**

#### JUSD → Other Token
- ✅ Successful swap with automatic JUSD → svJUSD conversion
- ✅ Deadline expiration handling
- ✅ Zero amount rejection
- ✅ Slippage protection (insufficient output)
- ✅ Automatic conversion verification

#### JUICE → Other Token
- ✅ Swap via Equity contract (JUICE → JUSD → svJUSD)
- ✅ Multi-step conversion validation
- ✅ Balance verification

#### Native cBTC
- ✅ Native cBTC → Token swaps
- ✅ msg.value validation
- ✅ Token → Native cBTC swaps
- ✅ Balance increase verification

### 4. **Liquidity Operations**

#### Add Liquidity
- ✅ JUSD + Token liquidity provision
- ✅ Automatic JUSD → svJUSD conversion
- ✅ Native cBTC + Token pairs
- ✅ Excess token returns
- ✅ Deadline validation
- ✅ NFT position creation (Uniswap V3)

#### Remove Liquidity
- ✅ Position burning and token withdrawal
- ✅ Automatic svJUSD → JUSD conversion
- ✅ Native cBTC withdrawal
- ✅ NFT transfer validation
- ✅ Deadline expiration

### 5. **Admin Functions**
- ✅ Default fee tier updates
- ✅ Pause/unpause functionality
- ✅ Access control (onlyOwner)
- ✅ Paused state swap blocking
- ✅ Native token rescue
- ✅ ERC20 token rescue
- ✅ Zero address protection

### 6. **Security Tests**
- ✅ Direct native transfer rejection
- ✅ ReentrancyGuard protection
- ✅ Transfer failure handling
- ✅ Owner-only function protection

### 7. **Edge Cases**
- ✅ Minimum amount (1 wei) handling
- ✅ Maximum uint256 approvals
- ✅ Token ordering (token0 < token1)
- ✅ Various token pair combinations

### 8. **Gas Optimization**
- ✅ Pre-approval efficiency testing
- ✅ Multiple sequential swaps
- ✅ Gas usage comparison

## Mock Contracts

All mocks are located in `/contracts/mocks/`:

### MockERC20
Basic ERC20 with mint/burn for testing.

### MockERC4626
ERC4626 vault implementation simulating svJUSD:
- Deposit/withdraw functionality
- Price per share simulation
- Interest accrual simulation

### MockEquity
Simulates JUICE/Equity contract:
- `invest()` - JUSD → JUICE conversion
- `redeem()` - JUICE → JUSD conversion
- Fixed pricing model (1 JUICE = 100 JUSD)
- View functions for calculations

### MockWETH
WETH-like wrapper for cBTC:
- `deposit()` - Native → Wrapped
- `withdraw()` - Wrapped → Native
- receive() fallback

### MockSwapRouter
Uniswap V3 SwapRouter simulation:
- `exactInputSingle()` implementation
- Configurable output amounts for testing
- Token transfer simulation

### MockPositionManager
Uniswap V3 NonfungiblePositionManager:
- NFT-based position management
- `mint()` - Create liquidity position
- `decreaseLiquidity()` - Remove liquidity
- `collect()` - Collect tokens
- Configurable test results

## Running Tests

### Run all tests
```bash
npm test
```

### Run specific test file
```bash
npx hardhat test test/JuiceSwapGateway.test.ts
```

### Run with gas reporting
```bash
REPORT_GAS=true npx hardhat test
```

### Run with coverage
```bash
npx hardhat coverage
```

## Test Fixtures

Tests use Hardhat's `loadFixture` for efficient test setup:

**`deployMocksFixture`**
- Deploys all mock contracts
- Sets up signers
- Returns all dependencies

**`deployGatewayFixture`**
- Includes mocks from deployMocksFixture
- Deploys JuiceSwapGateway
- Returns gateway + mocks

**`deployGatewayWithBalancesFixture`**
- Includes deployGatewayFixture
- Mints initial token balances for users
- Wraps some cBTC for testing
- Ready for immediate testing

## Test Coverage Goals

Target coverage metrics:
- **Statements**: > 95%
- **Branches**: > 90%
- **Functions**: > 95%
- **Lines**: > 95%

## Adding New Tests

When adding functionality:

1. **Add unit tests** for individual functions
2. **Add integration tests** for workflows
3. **Add edge case tests** for boundary conditions
4. **Update this README** with new test descriptions

### Test Template

```typescript
describe("New Feature", function () {
  it("Should do expected behavior", async function () {
    const { gateway, user1, ... } = await loadFixture(deployGatewayWithBalancesFixture);

    // Setup
    // Execute
    // Assert
  });

  it("Should revert on invalid input", async function () {
    // Test error conditions
  });
});
```

## Common Test Patterns

### Approval Pattern
```typescript
await token.connect(user).approve(gateway.getAddress(), amount);
```

### Deadline Pattern
```typescript
const deadline = (await time.latest()) + 3600; // 1 hour from now
```

### Event Testing
```typescript
await expect(tx)
  .to.emit(gateway, "EventName")
  .withArgs(arg1, arg2, ...);
```

### Error Testing
```typescript
await expect(
  gateway.functionCall(...)
).to.be.revertedWithCustomError(gateway, "ErrorName");
```

### Balance Checking
```typescript
const balanceBefore = await token.balanceOf(user.address);
// ... do operation ...
const balanceAfter = await token.balanceOf(user.address);
expect(balanceAfter).to.equal(balanceBefore + expectedChange);
```

## Debugging Tests

### Enable console logs
```typescript
import { console } from "hardhat/console.sol";
```

### Run single test
```bash
npx hardhat test --grep "test name pattern"
```

### Verbose output
```bash
npx hardhat test --verbose
```

## CI/CD Integration

Tests are automatically run on:
- Every commit (GitHub Actions)
- Every pull request
- Before deployment

### Required Checks
- ✅ All tests passing
- ✅ No compiler warnings
- ✅ Gas usage within limits
- ✅ Coverage threshold met

## Notes

- Tests use Hardhat Network with Citrea Testnet parameters
- ChainId: 5115 (Citrea Testnet)
- All amounts use 18 decimals
- Native token is cBTC (not ETH)
- Mock contracts simulate real behavior but with simplified logic
