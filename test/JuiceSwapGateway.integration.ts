import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Signer, Contract } from "ethers";
import { ADDRESS } from "@juicedollar/jusd";
import { WETH9, CHAIN_TO_ADDRESSES_MAP, ChainId } from "@juiceswapxyz/sdk-core";

/**
 * JuiceSwapGateway Integration Tests
 *
 * Run: CHAIN_ID=5115 FORK_CITREA=true yarn hardhat test test/JuiceSwapGateway.integration.ts
 *
 * Requires: DEPLOYER_PRIVATE_KEY env var with funded account (JUSD, WcBTC, cBTC)
 */

// Chain ID from environment or default to Citrea Testnet
const CHAIN_ID = Number(process.env.CHAIN_ID) || 5115;

// Build addresses from packages (single source of truth)
const jusdAddresses = ADDRESS[CHAIN_ID];
const dexAddresses = CHAIN_TO_ADDRESSES_MAP[CHAIN_ID as keyof typeof CHAIN_TO_ADDRESSES_MAP];

const ADDRESSES = {
  JuiceSwapGateway: dexAddresses.juiceSwapGatewayAddress!,
  JUSD: jusdAddresses.juiceDollar,
  svJUSD: jusdAddresses.savingsVaultJUSD,
  JUICE: jusdAddresses.equity,
  WcBTC: WETH9[CHAIN_ID as ChainId].address,
  PositionManager: dexAddresses.nonfungiblePositionManagerAddress!,
};

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
];

const GATEWAY_ABI = [
  "function swapExactTokensForTokens(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 minAmountOut, address to, uint256 deadline) payable returns (uint256)",
  "function addLiquidity(address tokenA, address tokenB, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) payable returns (uint256, uint256, uint256)",
  "function createPoolAndAddLiquidity(address tokenA, address tokenB, uint24 fee, uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) payable returns (address, uint256, uint256, uint256)",
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool, bool exists)",
  "function increaseLiquidity(uint256 tokenId, address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, uint256 deadline) payable returns (uint256, uint256, uint128)",
  "function removeLiquidity(uint256 tokenId, uint128 liquidityToRemove, address tokenA, address tokenB, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256, uint256)",
  "event SwapExecuted(address indexed user, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)",
  "event LiquidityAdded(address indexed user, address indexed tokenA, address indexed tokenB, uint256 amountA, uint256 amountB, uint256 tokenId)",
  "event LiquidityIncreased(address indexed user, uint256 indexed tokenId, uint256 amountA, uint256 amountB, uint128 liquidity)",
  "event LiquidityRemoved(address indexed user, address indexed tokenA, address indexed tokenB, uint256 amountA, uint256 amountB, uint256 tokenId)",
];

const POSITION_MANAGER_ABI = [
  "function positions(uint256 tokenId) view returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)",
  "function approve(address to, uint256 tokenId)",
  "function ownerOf(uint256 tokenId) view returns (address)",
];

// Skip unless connected to Citrea Testnet (live network or fork)
const isIntegrationTest =
  network.config.chainId === CHAIN_ID &&
  (network.name !== "hardhat" || process.env.FORK_CITREA === "true");

(isIntegrationTest ? describe : describe.skip)("JuiceSwapGateway Integration Tests (Citrea Testnet / Fork)", function () {
  this.timeout(120_000);

  let signer: Signer;
  let signerAddress: string;
  let gateway: Contract;
  let jusd: Contract;
  let wcbtc: Contract;
  let juice: Contract;
  let positionManager: Contract;

  const JUSD_AMOUNT = ethers.parseUnits("10", 18); // 10 JUSD (18 decimals)
  const WCBTC_AMOUNT = ethers.parseUnits("0.0001", 18); // 0.0001 WcBTC (18 decimals)
  const CBTC_AMOUNT = ethers.parseUnits("0.0001", 18); // 0.0001 cBTC (18 decimals)
  const FEE = 3000; // 0.3%

  const getDeadline = () => Math.floor(Date.now() / 1000) + 3600;

  async function ensureApproval(token: Contract, amount: bigint) {
    const allowance = await token.allowance(signerAddress, ADDRESSES.JuiceSwapGateway);
    if (allowance < amount) {
      const tx = await token.approve(ADDRESSES.JuiceSwapGateway, ethers.MaxUint256);
      await tx.wait();
    }
  }

  function findSwapEvent(receipt: any): { amountIn: bigint; amountOut: bigint } | null {
    for (const log of receipt.logs) {
      try {
        const parsed = gateway.interface.parseLog(log);
        if (parsed?.name === "SwapExecuted") {
          return { amountIn: parsed.args.amountIn, amountOut: parsed.args.amountOut };
        }
      } catch {
        // Not a gateway event
      }
    }
    return null;
  }

  function findLiquidityAddedEvent(receipt: any): { tokenId: bigint } | null {
    for (const log of receipt.logs) {
      try {
        const parsed = gateway.interface.parseLog(log);
        if (parsed?.name === "LiquidityAdded") {
          return { tokenId: parsed.args.tokenId };
        }
      } catch {
        // Not a gateway event
      }
    }
    return null;
  }

  function findLiquidityIncreasedEvent(receipt: any): { amountA: bigint; amountB: bigint; liquidity: bigint } | null {
    for (const log of receipt.logs) {
      try {
        const parsed = gateway.interface.parseLog(log);
        if (parsed?.name === "LiquidityIncreased") {
          return {
            amountA: parsed.args.amountA,
            amountB: parsed.args.amountB,
            liquidity: parsed.args.liquidity,
          };
        }
      } catch {
        // Not a gateway event
      }
    }
    return null;
  }

  function findLiquidityRemovedEvent(receipt: any): { amountA: bigint; amountB: bigint } | null {
    for (const log of receipt.logs) {
      try {
        const parsed = gateway.interface.parseLog(log);
        if (parsed?.name === "LiquidityRemoved") {
          return { amountA: parsed.args.amountA, amountB: parsed.args.amountB };
        }
      } catch {
        // Not a gateway event
      }
    }
    return null;
  }

  async function ensureNFTApproval(tokenId: bigint) {
    const tx = await positionManager.approve(ADDRESSES.JuiceSwapGateway, tokenId);
    await tx.wait();
  }

  async function getPositionLiquidity(tokenId: bigint): Promise<bigint> {
    const position = await positionManager.positions(tokenId);
    return position[7]; // liquidity is at index 7
  }

  before(async function () {
    // Workaround for Hardhat fork bug with unknown chains
    // See: https://github.com/NomicFoundation/hardhat/issues/5511
    if (network.name === "hardhat") {
      await network.provider.send("hardhat_mine", ["0x1"]);
    }

    const signers = await ethers.getSigners();
    if (signers.length === 0) {
      console.log("Skipping: No signer. Set DEPLOYER_PRIVATE_KEY env var.");
      return this.skip();
    }

    signer = signers[0];
    signerAddress = await signer.getAddress();
    console.log(`\n  Test account: ${signerAddress}`);

    gateway = new ethers.Contract(ADDRESSES.JuiceSwapGateway, GATEWAY_ABI, signer);
    jusd = new ethers.Contract(ADDRESSES.JUSD, ERC20_ABI, signer);
    wcbtc = new ethers.Contract(ADDRESSES.WcBTC, ERC20_ABI, signer);
    juice = new ethers.Contract(ADDRESSES.JUICE, ERC20_ABI, signer);
    positionManager = new ethers.Contract(ADDRESSES.PositionManager, POSITION_MANAGER_ABI, signer);

    const [jusdBal, wcbtcBal, cbtcBal] = await Promise.all([
      jusd.balanceOf(signerAddress),
      wcbtc.balanceOf(signerAddress),
      ethers.provider.getBalance(signerAddress),
    ]);

    console.log(`  JUSD: ${ethers.formatUnits(jusdBal, 18)}`);
    console.log(`  WcBTC: ${ethers.formatUnits(wcbtcBal, 18)}`);
    console.log(`  cBTC: ${ethers.formatUnits(cbtcBal, 18)}\n`);
  });

  describe("0. Pool Bootstrap", function () {
    it("Should create WcBTC/JUSD pool with initial liquidity", async function () {
      // Check if pool already exists (allows running on testnet with existing pool)
      const [existingPool, exists] = await gateway.getPool(ADDRESSES.JUSD, ADDRESSES.WcBTC, FEE);
      if (exists) {
        console.log(`    Pool already exists: ${existingPool}`);
        return;
      }

      // Ensure we have enough JUSD
      const jusdBalance = await jusd.balanceOf(signerAddress);
      const requiredJusd = ethers.parseUnits("10000", 18); // 10,000 JUSD
      if (jusdBalance < requiredJusd) {
        console.log(`    Skipping: Need 10,000 JUSD, have ${ethers.formatUnits(jusdBalance, 18)}`);
        this.skip();
      }

      // Price: 1 WcBTC (cBTC) = 100,000 JUSD (realistic BTC price)
      // sqrtPriceX96 = sqrt(token1/token0) * 2^96
      // token0 = svJUSD (lower address), token1 = WcBTC
      // price = WcBTC/svJUSD = 0.00001 (1 svJUSD buys 0.00001 WcBTC)
      const priceRatio = 0.00001; // 1/100000
      const sqrtPriceX96 = BigInt(Math.floor(Math.sqrt(priceRatio) * 2 ** 96));

      const jusdAmount = ethers.parseUnits("10000", 18); // 10,000 JUSD
      const cbtcAmount = ethers.parseEther("0.1"); // 0.1 cBTC (~$10,000 at $100k/BTC)

      await ensureApproval(jusd, jusdAmount);

      console.log(`    Creating pool: 10,000 JUSD + 0.1 cBTC @ 1:100000 price...`);
      const tx = await gateway.createPoolAndAddLiquidity(
        ADDRESSES.JUSD,
        ethers.ZeroAddress, // native cBTC
        FEE,
        sqrtPriceX96,
        0, 0, // full range (sentinel values)
        jusdAmount,
        cbtcAmount,
        0, 0, // no slippage for setup
        signerAddress,
        getDeadline(),
        { value: cbtcAmount }
      );
      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1);

      // Verify pool was created
      const [poolAddr, poolExists] = await gateway.getPool(ADDRESSES.JUSD, ADDRESSES.WcBTC, FEE);
      expect(poolExists).to.be.true;
      console.log(`    Pool created at: ${poolAddr}`);

      // Extract tokenId from event
      const event = findLiquidityAddedEvent(receipt);
      if (event) {
        console.log(`    Initial liquidity NFT: ${event.tokenId}`);
      }
    });
  });

  describe("1. JUSD -> WcBTC", function () {
    it("Should swap JUSD for WcBTC (JUSD->svJUSD conversion + pool swap)", async function () {
      const [, poolExists] = await gateway.getPool(ADDRESSES.JUSD, ADDRESSES.WcBTC, FEE);
      if (!poolExists) {
        console.log(`    Skipping: Pool not bootstrapped`);
        this.skip();
      }

      const balance = await jusd.balanceOf(signerAddress);
      if (balance < JUSD_AMOUNT) this.skip();

      await ensureApproval(jusd, JUSD_AMOUNT);
      const jusdBefore = await jusd.balanceOf(signerAddress);
      const wcbtcBefore = await wcbtc.balanceOf(signerAddress);

      console.log(`    Swapping ${ethers.formatUnits(JUSD_AMOUNT, 18)} JUSD -> WcBTC...`);
      const tx = await gateway.swapExactTokensForTokens(
        ADDRESSES.JUSD,
        ADDRESSES.WcBTC,
        FEE,
        JUSD_AMOUNT,
        0,
        signerAddress,
        getDeadline()
      );
      const receipt = await tx.wait();

      const jusdAfter = await jusd.balanceOf(signerAddress);
      const wcbtcAfter = await wcbtc.balanceOf(signerAddress);
      const jusdSpent = jusdBefore - jusdAfter;
      const wcbtcReceived = wcbtcAfter - wcbtcBefore;
      console.log(
        `    Spent: ${ethers.formatUnits(jusdSpent, 18)} JUSD, Received: ${ethers.formatUnits(wcbtcReceived, 18)} WcBTC`
      );

      expect(receipt.status).to.equal(1);

      // Verify input was spent
      expect(jusdSpent).to.equal(JUSD_AMOUNT);

      // Verify output received
      expect(wcbtcReceived).to.be.gt(0);

      // Verify event exists and amounts match actual balance changes
      const swapEvent = findSwapEvent(receipt);
      expect(swapEvent).to.not.be.null;
      expect(swapEvent!.amountIn).to.equal(JUSD_AMOUNT);
      expect(swapEvent!.amountOut).to.equal(wcbtcReceived);
    });
  });

  describe("2. WcBTC -> JUSD", function () {
    it("Should swap WcBTC for JUSD (pool swap + svJUSD->JUSD conversion)", async function () {
      const [, poolExists] = await gateway.getPool(ADDRESSES.JUSD, ADDRESSES.WcBTC, FEE);
      if (!poolExists) {
        console.log(`    Skipping: Pool not bootstrapped`);
        this.skip();
      }

      const balance = await wcbtc.balanceOf(signerAddress);
      if (balance < WCBTC_AMOUNT) this.skip();

      await ensureApproval(wcbtc, WCBTC_AMOUNT);
      const wcbtcBefore = await wcbtc.balanceOf(signerAddress);
      const jusdBefore = await jusd.balanceOf(signerAddress);

      console.log(`    Swapping ${ethers.formatUnits(WCBTC_AMOUNT, 18)} WcBTC -> JUSD...`);
      const tx = await gateway.swapExactTokensForTokens(
        ADDRESSES.WcBTC,
        ADDRESSES.JUSD,
        FEE,
        WCBTC_AMOUNT,
        0,
        signerAddress,
        getDeadline()
      );
      const receipt = await tx.wait();

      const wcbtcAfter = await wcbtc.balanceOf(signerAddress);
      const jusdAfter = await jusd.balanceOf(signerAddress);
      const wcbtcSpent = wcbtcBefore - wcbtcAfter;
      const jusdReceived = jusdAfter - jusdBefore;
      console.log(
        `    Spent: ${ethers.formatUnits(wcbtcSpent, 18)} WcBTC, Received: ${ethers.formatUnits(jusdReceived, 18)} JUSD`
      );

      expect(receipt.status).to.equal(1);

      // Verify input was spent
      expect(wcbtcSpent).to.equal(WCBTC_AMOUNT);

      // Verify output received
      expect(jusdReceived).to.be.gt(0);

      // Verify event exists and amounts match actual balance changes
      const swapEvent = findSwapEvent(receipt);
      expect(swapEvent).to.not.be.null;
      expect(swapEvent!.amountIn).to.equal(WCBTC_AMOUNT);
      expect(swapEvent!.amountOut).to.equal(jusdReceived);
    });
  });

  describe("3. Native cBTC -> JUSD", function () {
    it("Should swap native cBTC for JUSD (cBTC->WcBTC wrap + pool swap + svJUSD->JUSD)", async function () {
      const [, poolExists] = await gateway.getPool(ADDRESSES.JUSD, ADDRESSES.WcBTC, FEE);
      if (!poolExists) {
        console.log(`    Skipping: Pool not bootstrapped`);
        this.skip();
      }

      const balance = await ethers.provider.getBalance(signerAddress);
      if (balance < CBTC_AMOUNT + ethers.parseEther("0.0005")) this.skip();

      const jusdBefore = await jusd.balanceOf(signerAddress);

      console.log(`    Swapping ${ethers.formatUnits(CBTC_AMOUNT, 18)} cBTC -> JUSD...`);
      const tx = await gateway.swapExactTokensForTokens(
        ethers.ZeroAddress,
        ADDRESSES.JUSD,
        FEE,
        CBTC_AMOUNT,
        0,
        signerAddress,
        getDeadline(),
        { value: CBTC_AMOUNT }
      );
      const receipt = await tx.wait();

      const jusdAfter = await jusd.balanceOf(signerAddress);
      const jusdReceived = jusdAfter - jusdBefore;
      console.log(`    Received: ${ethers.formatUnits(jusdReceived, 18)} JUSD`);

      expect(receipt.status).to.equal(1);

      // Verify output received
      expect(jusdReceived).to.be.gt(0);

      // Verify event exists and amounts match
      // Note: Can't verify native cBTC input decrease due to gas complications
      const swapEvent = findSwapEvent(receipt);
      expect(swapEvent).to.not.be.null;
      expect(swapEvent!.amountIn).to.equal(CBTC_AMOUNT);
      expect(swapEvent!.amountOut).to.equal(jusdReceived);
    });
  });

  describe("4. WcBTC -> JUICE", function () {
    it("Should swap WcBTC for JUICE (pool swap + svJUSD->JUSD + Equity.invest)", async function () {
      const [, poolExists] = await gateway.getPool(ADDRESSES.JUSD, ADDRESSES.WcBTC, FEE);
      if (!poolExists) {
        console.log(`    Skipping: Pool not bootstrapped`);
        this.skip();
      }

      const balance = await wcbtc.balanceOf(signerAddress);
      if (balance < WCBTC_AMOUNT) this.skip();

      await ensureApproval(wcbtc, WCBTC_AMOUNT);
      const wcbtcBefore = await wcbtc.balanceOf(signerAddress);
      const juiceBefore = await juice.balanceOf(signerAddress);

      console.log(`    Swapping ${ethers.formatUnits(WCBTC_AMOUNT, 18)} WcBTC -> JUICE...`);
      const tx = await gateway.swapExactTokensForTokens(
        ADDRESSES.WcBTC,
        ADDRESSES.JUICE,
        FEE,
        WCBTC_AMOUNT,
        0,
        signerAddress,
        getDeadline()
      );
      const receipt = await tx.wait();

      const wcbtcAfter = await wcbtc.balanceOf(signerAddress);
      const juiceAfter = await juice.balanceOf(signerAddress);
      const wcbtcSpent = wcbtcBefore - wcbtcAfter;
      const juiceReceived = juiceAfter - juiceBefore;
      console.log(
        `    Spent: ${ethers.formatUnits(wcbtcSpent, 18)} WcBTC, Received: ${ethers.formatUnits(juiceReceived, 18)} JUICE`
      );

      expect(receipt.status).to.equal(1);

      // Verify input was spent
      expect(wcbtcSpent).to.equal(WCBTC_AMOUNT);

      // Verify output received
      expect(juiceReceived).to.be.gt(0);

      // Verify event exists and amounts match actual balance changes
      const swapEvent = findSwapEvent(receipt);
      expect(swapEvent).to.not.be.null;
      expect(swapEvent!.amountIn).to.equal(WCBTC_AMOUNT);
      expect(swapEvent!.amountOut).to.equal(juiceReceived);
    });
  });

  describe("5. Native cBTC -> JUICE", function () {
    it("Should swap native cBTC for JUICE (full conversion chain)", async function () {
      const [, poolExists] = await gateway.getPool(ADDRESSES.JUSD, ADDRESSES.WcBTC, FEE);
      if (!poolExists) {
        console.log(`    Skipping: Pool not bootstrapped`);
        this.skip();
      }

      const balance = await ethers.provider.getBalance(signerAddress);
      if (balance < CBTC_AMOUNT + ethers.parseEther("0.0005")) this.skip();

      const juiceBefore = await juice.balanceOf(signerAddress);

      console.log(`    Swapping ${ethers.formatUnits(CBTC_AMOUNT, 18)} cBTC -> JUICE...`);
      const tx = await gateway.swapExactTokensForTokens(
        ethers.ZeroAddress,
        ADDRESSES.JUICE,
        FEE,
        CBTC_AMOUNT,
        0,
        signerAddress,
        getDeadline(),
        { value: CBTC_AMOUNT }
      );
      const receipt = await tx.wait();

      const juiceAfter = await juice.balanceOf(signerAddress);
      const juiceReceived = juiceAfter - juiceBefore;
      console.log(`    Received: ${ethers.formatUnits(juiceReceived, 18)} JUICE`);

      expect(receipt.status).to.equal(1);

      // Verify output received
      expect(juiceReceived).to.be.gt(0);

      // Verify event exists and amounts match
      // Note: Can't verify native cBTC input decrease due to gas complications
      const swapEvent = findSwapEvent(receipt);
      expect(swapEvent).to.not.be.null;
      expect(swapEvent!.amountIn).to.equal(CBTC_AMOUNT);
      expect(swapEvent!.amountOut).to.equal(juiceReceived);
    });
  });

  describe("6. Liquidity Lifecycle", function () {
    let positionTokenId: bigint;

    it("6a. Should add liquidity with JUSD + WcBTC", async function () {
      const [, poolExists] = await gateway.getPool(ADDRESSES.JUSD, ADDRESSES.WcBTC, FEE);
      if (!poolExists) {
        console.log(`    Skipping: Pool not bootstrapped`);
        this.skip();
      }

      const jusdBalance = await jusd.balanceOf(signerAddress);
      const wcbtcBalance = await wcbtc.balanceOf(signerAddress);

      // Use larger amounts for liquidity
      const jusdAmount = ethers.parseUnits("100", 18); // 100 JUSD (18 decimals)
      const wcbtcAmount = ethers.parseUnits("0.001", 18); // 0.001 WcBTC (18 decimals)

      if (jusdBalance < jusdAmount || wcbtcBalance < wcbtcAmount) {
        console.log(`    Skipping: Insufficient balance (need 10 JUSD and some WcBTC)`);
        this.skip();
      }

      await ensureApproval(jusd, jusdAmount);
      await ensureApproval(wcbtc, wcbtcAmount);

      const jusdBefore = await jusd.balanceOf(signerAddress);
      const wcbtcBefore = await wcbtc.balanceOf(signerAddress);

      console.log(
        `    Adding liquidity: ${ethers.formatUnits(jusdAmount, 18)} JUSD + ${ethers.formatUnits(wcbtcAmount, 18)} WcBTC...`
      );
      const tx = await gateway.addLiquidity(
        ADDRESSES.JUSD,
        ADDRESSES.WcBTC,
        FEE,
        0, // tickLower (full range)
        0, // tickUpper (full range)
        jusdAmount,
        wcbtcAmount,
        0,
        0,
        signerAddress,
        getDeadline()
      );
      const receipt = await tx.wait();

      expect(receipt.status).to.equal(1);

      const eventData = findLiquidityAddedEvent(receipt);
      expect(eventData).to.not.be.null;
      positionTokenId = eventData!.tokenId;
      console.log(`    Position NFT minted: tokenId=${positionTokenId}`);

      // Verify NFT ownership
      const owner = await positionManager.ownerOf(positionTokenId);
      expect(owner).to.equal(signerAddress);

      const liquidity = await getPositionLiquidity(positionTokenId);
      console.log(`    Position liquidity: ${liquidity}`);
      expect(liquidity).to.be.gt(0);

      // Verify tokens were taken from user
      const jusdAfter = await jusd.balanceOf(signerAddress);
      const wcbtcAfter = await wcbtc.balanceOf(signerAddress);
      const jusdSpent = jusdBefore - jusdAfter;
      const wcbtcSpent = wcbtcBefore - wcbtcAfter;
      console.log(`    Spent: ${ethers.formatUnits(jusdSpent, 18)} JUSD, ${ethers.formatUnits(wcbtcSpent, 18)} WcBTC`);
      expect(jusdSpent).to.be.gt(0);
      expect(wcbtcSpent).to.be.gt(0);
    });

    it("6b. Should increase liquidity on existing position", async function () {
      if (!positionTokenId) {
        console.log(`    Skipping: No position from 6a`);
        this.skip();
      }

      const jusdBalance = await jusd.balanceOf(signerAddress);
      const wcbtcBalance = await wcbtc.balanceOf(signerAddress);

      const jusdAmount = ethers.parseUnits("50", 18); // 50 JUSD (18 decimals)
      const wcbtcAmount = ethers.parseUnits("0.0005", 18); // 0.0005 WcBTC (18 decimals)

      if (jusdBalance < jusdAmount || wcbtcBalance < wcbtcAmount) {
        console.log(`    Skipping: Insufficient balance for increase`);
        this.skip();
      }

      const liquidityBefore = await getPositionLiquidity(positionTokenId);

      // Approve NFT to gateway
      await ensureNFTApproval(positionTokenId);
      await ensureApproval(jusd, jusdAmount);
      await ensureApproval(wcbtc, wcbtcAmount);

      const jusdBefore = await jusd.balanceOf(signerAddress);
      const wcbtcBefore = await wcbtc.balanceOf(signerAddress);

      console.log(
        `    Increasing liquidity: +${ethers.formatUnits(jusdAmount, 18)} JUSD + ${ethers.formatUnits(wcbtcAmount, 18)} WcBTC...`
      );
      const tx = await gateway.increaseLiquidity(
        positionTokenId,
        ADDRESSES.JUSD,
        ADDRESSES.WcBTC,
        jusdAmount,
        wcbtcAmount,
        0,
        0,
        getDeadline()
      );
      const receipt = await tx.wait();

      expect(receipt.status).to.equal(1);

      const eventData = findLiquidityIncreasedEvent(receipt);
      expect(eventData).to.not.be.null;
      console.log(`    Liquidity added: ${eventData!.liquidity}`);
      console.log(
        `    Event amounts: ${ethers.formatUnits(eventData!.amountA, 18)} JUSD, ${ethers.formatUnits(eventData!.amountB, 18)} WcBTC`
      );

      // Verify NFT returned to user
      const owner = await positionManager.ownerOf(positionTokenId);
      expect(owner).to.equal(signerAddress);

      const liquidityAfter = await getPositionLiquidity(positionTokenId);
      console.log(`    Position liquidity: ${liquidityBefore} -> ${liquidityAfter}`);
      expect(liquidityAfter).to.be.gt(liquidityBefore);

      // Verify tokens were taken from user
      const jusdAfter = await jusd.balanceOf(signerAddress);
      const wcbtcAfter = await wcbtc.balanceOf(signerAddress);
      const jusdSpent = jusdBefore - jusdAfter;
      const wcbtcSpent = wcbtcBefore - wcbtcAfter;
      console.log(`    Spent: ${ethers.formatUnits(jusdSpent, 18)} JUSD, ${ethers.formatUnits(wcbtcSpent, 18)} WcBTC`);
      expect(jusdSpent).to.be.gt(0);
      expect(wcbtcSpent).to.be.gt(0);

      // Verify event amounts match balance changes
      // WcBTC: exact match (no conversion)
      expect(eventData!.amountB).to.equal(wcbtcSpent);
      // JUSD: close match (small variance due to svJUSD exchange rate conversions)
      // Allow 1% tolerance for the JUSD→svJUSD→JUSD round-trip
      const jusdDiff = eventData!.amountA > jusdSpent ? eventData!.amountA - jusdSpent : jusdSpent - eventData!.amountA;
      const tolerance = jusdSpent / 100n; // 1%
      expect(jusdDiff).to.be.lte(tolerance);
    });

    it("6c. Should remove partial liquidity", async function () {
      if (!positionTokenId) {
        console.log(`    Skipping: No position from 6a`);
        this.skip();
      }

      const liquidityBefore = await getPositionLiquidity(positionTokenId);
      const liquidityToRemove = liquidityBefore / 2n;

      if (liquidityToRemove === 0n) {
        console.log(`    Skipping: No liquidity to remove`);
        this.skip();
      }

      const jusdBefore = await jusd.balanceOf(signerAddress);
      const wcbtcBefore = await wcbtc.balanceOf(signerAddress);

      await ensureNFTApproval(positionTokenId);

      console.log(`    Removing half liquidity: ${liquidityToRemove}...`);
      const tx = await gateway.removeLiquidity(
        positionTokenId,
        liquidityToRemove,
        ADDRESSES.JUSD,
        ADDRESSES.WcBTC,
        0,
        0,
        signerAddress,
        getDeadline()
      );
      const receipt = await tx.wait();

      expect(receipt.status).to.equal(1);

      const removedEvent = findLiquidityRemovedEvent(receipt);
      expect(removedEvent).to.not.be.null;

      // Verify position still has liquidity
      const liquidityAfter = await getPositionLiquidity(positionTokenId);
      console.log(`    Position liquidity: ${liquidityBefore} -> ${liquidityAfter}`);
      expect(liquidityAfter).to.be.gt(0);
      expect(liquidityAfter).to.be.lt(liquidityBefore);

      // Verify NFT returned to user after partial removal
      const ownerAfterPartialRemoval = await positionManager.ownerOf(positionTokenId);
      expect(ownerAfterPartialRemoval).to.equal(signerAddress);

      // Verify tokens received (check each individually since they have different decimals)
      const jusdAfter = await jusd.balanceOf(signerAddress);
      const wcbtcAfter = await wcbtc.balanceOf(signerAddress);
      console.log(
        `    Received: ${ethers.formatUnits(jusdAfter - jusdBefore, 18)} JUSD, ${ethers.formatUnits(wcbtcAfter - wcbtcBefore, 18)} WcBTC`
      );
      expect(jusdAfter).to.be.gt(jusdBefore);
      expect(wcbtcAfter).to.be.gt(wcbtcBefore);
    });

    it("6d. Should remove all remaining liquidity", async function () {
      if (!positionTokenId) {
        console.log(`    Skipping: No position from 6a`);
        this.skip();
      }

      const liquidityBefore = await getPositionLiquidity(positionTokenId);
      if (liquidityBefore === 0n) {
        console.log(`    Skipping: No remaining liquidity`);
        this.skip();
      }

      const jusdBefore = await jusd.balanceOf(signerAddress);
      const wcbtcBefore = await wcbtc.balanceOf(signerAddress);

      await ensureNFTApproval(positionTokenId);

      console.log(`    Removing all remaining liquidity (passing 0 to remove all)...`);
      const tx = await gateway.removeLiquidity(
        positionTokenId,
        0, // 0 means remove all
        ADDRESSES.JUSD,
        ADDRESSES.WcBTC,
        0,
        0,
        signerAddress,
        getDeadline()
      );
      const receipt = await tx.wait();

      expect(receipt.status).to.equal(1);

      const removedEvent = findLiquidityRemovedEvent(receipt);
      expect(removedEvent).to.not.be.null;

      // Verify all liquidity was removed from position
      const liquidityAfter = await getPositionLiquidity(positionTokenId);
      expect(liquidityAfter).to.equal(0n);

      // Verify tokens received (check each individually since they have different decimals)
      const jusdAfter = await jusd.balanceOf(signerAddress);
      const wcbtcAfter = await wcbtc.balanceOf(signerAddress);
      console.log(
        `    Received: ${ethers.formatUnits(jusdAfter - jusdBefore, 18)} JUSD, ${ethers.formatUnits(wcbtcAfter - wcbtcBefore, 18)} WcBTC`
      );
      expect(jusdAfter).to.be.gt(jusdBefore);
      expect(wcbtcAfter).to.be.gt(wcbtcBefore);
    });
  });

  describe("7. Liquidity Lifecycle with Native cBTC", function () {
    let positionTokenId: bigint;

    it("7a. Should add liquidity with native cBTC + JUSD", async function () {
      const [, poolExists] = await gateway.getPool(ADDRESSES.JUSD, ADDRESSES.WcBTC, FEE);
      if (!poolExists) {
        console.log(`    Skipping: Pool not bootstrapped`);
        this.skip();
      }

      const cbtcBalance = await ethers.provider.getBalance(signerAddress);
      const jusdBalance = await jusd.balanceOf(signerAddress);

      const cbtcAmount = ethers.parseUnits("0.001", 18); // 0.001 cBTC (18 decimals)
      const jusdAmount = ethers.parseUnits("100", 18); // 100 JUSD (18 decimals)

      if (cbtcBalance < cbtcAmount + ethers.parseEther("0.0005") || jusdBalance < jusdAmount) {
        console.log(`    Skipping: Insufficient balance (need some cBTC and 10 JUSD)`);
        this.skip();
      }

      // Only approve JUSD (cBTC sent as value)
      await ensureApproval(jusd, jusdAmount);

      const jusdBefore = await jusd.balanceOf(signerAddress);

      console.log(
        `    Adding liquidity: ${ethers.formatUnits(jusdAmount, 18)} JUSD + ${ethers.formatUnits(cbtcAmount, 18)} native cBTC...`
      );
      const tx = await gateway.addLiquidity(
        ADDRESSES.JUSD,
        ethers.ZeroAddress, // native cBTC
        FEE,
        0, // tickLower (full range)
        0, // tickUpper (full range)
        jusdAmount,
        cbtcAmount,
        0,
        0,
        signerAddress,
        getDeadline(),
        { value: cbtcAmount }
      );
      const receipt = await tx.wait();

      expect(receipt.status).to.equal(1);

      const eventData = findLiquidityAddedEvent(receipt);
      expect(eventData).to.not.be.null;
      positionTokenId = eventData!.tokenId;
      console.log(`    Position NFT minted: tokenId=${positionTokenId}`);

      // Verify NFT ownership
      const owner = await positionManager.ownerOf(positionTokenId);
      expect(owner).to.equal(signerAddress);

      const liquidity = await getPositionLiquidity(positionTokenId);
      console.log(`    Position liquidity: ${liquidity}`);
      expect(liquidity).to.be.gt(0);

      // Verify JUSD was taken from user (can't verify native cBTC due to gas complications)
      const jusdAfter = await jusd.balanceOf(signerAddress);
      const jusdSpent = jusdBefore - jusdAfter;
      console.log(`    Spent: ${ethers.formatUnits(jusdSpent, 18)} JUSD`);
      expect(jusdSpent).to.be.gt(0);
    });

    it("7b. Should increase liquidity with native cBTC on position from 7a", async function () {
      if (!positionTokenId) {
        console.log(`    Skipping: No position from 7a`);
        this.skip();
      }

      const cbtcBalance = await ethers.provider.getBalance(signerAddress);
      const jusdBalance = await jusd.balanceOf(signerAddress);

      const cbtcAmount = ethers.parseUnits("0.0005", 18); // 0.0005 cBTC (18 decimals)
      const jusdAmount = ethers.parseUnits("50", 18); // 50 JUSD (18 decimals)

      if (cbtcBalance < cbtcAmount + ethers.parseEther("0.0005") || jusdBalance < jusdAmount) {
        console.log(`    Skipping: Insufficient balance for increase`);
        this.skip();
      }

      const liquidityBefore = await getPositionLiquidity(positionTokenId);

      // Approve NFT to gateway
      await ensureNFTApproval(positionTokenId);
      // Only approve JUSD (cBTC sent as value)
      await ensureApproval(jusd, jusdAmount);

      const jusdBefore = await jusd.balanceOf(signerAddress);

      console.log(
        `    Increasing liquidity: +${ethers.formatUnits(jusdAmount, 18)} JUSD + ${ethers.formatUnits(cbtcAmount, 18)} native cBTC...`
      );
      const tx = await gateway.increaseLiquidity(
        positionTokenId,
        ADDRESSES.JUSD,
        ethers.ZeroAddress, // native cBTC
        jusdAmount,
        cbtcAmount,
        0,
        0,
        getDeadline(),
        { value: cbtcAmount }
      );
      const receipt = await tx.wait();

      expect(receipt.status).to.equal(1);

      const eventData = findLiquidityIncreasedEvent(receipt);
      expect(eventData).to.not.be.null;
      console.log(`    Liquidity added: ${eventData!.liquidity}`);
      console.log(
        `    Event amounts: ${ethers.formatUnits(eventData!.amountA, 18)} JUSD, ${ethers.formatUnits(eventData!.amountB, 18)} cBTC`
      );

      // Verify NFT returned to user
      const owner = await positionManager.ownerOf(positionTokenId);
      expect(owner).to.equal(signerAddress);

      const liquidityAfter = await getPositionLiquidity(positionTokenId);
      console.log(`    Position liquidity: ${liquidityBefore} -> ${liquidityAfter}`);
      expect(liquidityAfter).to.be.gt(liquidityBefore);

      // Verify JUSD was taken from user (can't verify native cBTC due to gas complications)
      const jusdAfter = await jusd.balanceOf(signerAddress);
      const jusdSpent = jusdBefore - jusdAfter;
      console.log(`    Spent: ${ethers.formatUnits(jusdSpent, 18)} JUSD`);
      expect(jusdSpent).to.be.gt(0);

      // Verify event amounts
      // JUSD: close match (small variance due to svJUSD exchange rate conversions)
      const jusdDiff = eventData!.amountA > jusdSpent ? eventData!.amountA - jusdSpent : jusdSpent - eventData!.amountA;
      const tolerance = jusdSpent / 100n; // 1%
      expect(jusdDiff).to.be.lte(tolerance);
      // Native cBTC: verify it's non-zero and at most what was sent (can't verify exact due to gas)
      expect(eventData!.amountB).to.be.gt(0);
      expect(eventData!.amountB).to.be.lte(cbtcAmount);
    });

    it("7c. Should remove liquidity and receive native cBTC", async function () {
      if (!positionTokenId) {
        console.log(`    Skipping: No position from 7a/7b`);
        this.skip();
      }

      const liquidityBefore = await getPositionLiquidity(positionTokenId);
      if (liquidityBefore === 0n) {
        console.log(`    Skipping: No liquidity to remove`);
        this.skip();
      }

      const jusdBefore = await jusd.balanceOf(signerAddress);
      const wcbtcBefore = await wcbtc.balanceOf(signerAddress);

      await ensureNFTApproval(positionTokenId);

      console.log(`    Removing all liquidity (passing 0 to remove all)...`);
      const tx = await gateway.removeLiquidity(
        positionTokenId,
        0, // 0 means remove all
        ADDRESSES.JUSD,
        ethers.ZeroAddress, // request native cBTC back
        0,
        0,
        signerAddress,
        getDeadline()
      );
      const receipt = await tx.wait();

      expect(receipt.status).to.equal(1);

      // Verify LiquidityRemoved event with non-zero amounts for both tokens
      const removedEvent = findLiquidityRemovedEvent(receipt);
      expect(removedEvent).to.not.be.null;
      expect(removedEvent!.amountA).to.be.gt(0); // JUSD amount
      expect(removedEvent!.amountB).to.be.gt(0); // cBTC amount (proves gateway processed the WcBTC)

      console.log(
        `    Event amounts: ${ethers.formatUnits(removedEvent!.amountA, 18)} JUSD, ${ethers.formatUnits(removedEvent!.amountB, 18)} cBTC`
      );

      // Verify all liquidity was removed from position
      const liquidityAfter = await getPositionLiquidity(positionTokenId);
      expect(liquidityAfter).to.equal(0n);

      // Verify tokens received
      const jusdAfter = await jusd.balanceOf(signerAddress);
      const wcbtcAfter = await wcbtc.balanceOf(signerAddress);

      const jusdReceived = jusdAfter - jusdBefore;
      const wcbtcChange = wcbtcAfter - wcbtcBefore;

      console.log(`    Received: ${ethers.formatUnits(jusdReceived, 18)} JUSD`);
      console.log(`    WcBTC change: ${wcbtcChange} (should be 0 if unwrapped to native)`);

      // Verify JUSD was received (svJUSD -> JUSD conversion worked)
      expect(jusdReceived).to.be.gt(0);

      // Verify WcBTC was NOT received as ERC20 - combined with amountB > 0 in event,
      // this proves the gateway unwrapped WcBTC to native cBTC instead of sending WcBTC directly.
      // Note: We can't verify native cBTC balance increase due to Citrea's L2 fee structure
      // (L1 data costs make gas accounting impossible), but the combination of:
      // 1. Event shows non-zero cBTC amount processed
      // 2. User's WcBTC balance unchanged
      // proves the unwrap-and-send-native path was executed.
      expect(wcbtcChange).to.equal(0n);
    });
  });
});
