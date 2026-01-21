import { expect } from "chai";
import { ethers } from "hardhat";
import { Signer, Contract } from "ethers";

/**
 * JuiceSwapGateway Integration Tests - Citrea Testnet
 *
 * Run: yarn hardhat test test/JuiceSwapGateway.integration.ts --network citreaTestnet
 *
 * Prerequisites:
 * - DEPLOYER_PRIVATE_KEY env var with funded account (JUSD, WcBTC, native cBTC)
 */

const ADDRESSES = {
  JuiceSwapGateway: "0x44B89B1a71f72aB6FeFa807686511f3589163704",
  JUSD: "0xFdB0a83d94CD65151148a131167Eb499Cb85d015",
  svJUSD: "0x9580498224551E3f2e3A04330a684BF025111C53",
  WcBTC: "0x8d0c9d1c17aE5e40ffF9bE350f57840E9E66Cd93",
  JUICE: "0x7b2A560bf72B0Dd2EAbE3271F829C2597c8420d5",
  PositionManager: "0x56D63E0F763b29F62bb7242420d028F86e9402E1",
};

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
];

const GATEWAY_ABI = [
  "function swapExactTokensForTokens(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 minAmountOut, address to, uint256 deadline) payable returns (uint256)",
  "function addLiquidity(address tokenA, address tokenB, uint24 fee, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) payable returns (uint256, uint256, uint256)",
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

// Skip entire test suite if not on Citrea Testnet
const isIntegrationTest = process.env.HARDHAT_NETWORK === "citreaTestnet";

(isIntegrationTest ? describe : describe.skip)("JuiceSwapGateway Integration Tests (Citrea Testnet)", function () {
  this.timeout(120_000);

  let signer: Signer;
  let signerAddress: string;
  let gateway: Contract;
  let jusd: Contract;
  let wcbtc: Contract;
  let juice: Contract;
  let positionManager: Contract;

  const JUSD_AMOUNT = 1_000_000n; // 1 JUSD (6 decimals)
  const WCBTC_AMOUNT = 1000n; // 0.00001 WcBTC (8 decimals)
  const CBTC_AMOUNT = 1000n; // 0.00001 cBTC (8 decimals)
  const FEE = 3000; // 0.3%

  const getDeadline = () => Math.floor(Date.now() / 1000) + 3600;

  async function ensureApproval(token: Contract, amount: bigint) {
    const allowance = await token.allowance(signerAddress, ADDRESSES.JuiceSwapGateway);
    if (allowance < amount) {
      const tx = await token.approve(ADDRESSES.JuiceSwapGateway, ethers.MaxUint256);
      await tx.wait();
    }
  }

  function findSwapEvent(receipt: any): boolean {
    return receipt.logs.some((log: any) => {
      try {
        return gateway.interface.parseLog(log)?.name === "SwapExecuted";
      } catch {
        return false;
      }
    });
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

  function findLiquidityIncreasedEvent(receipt: any): { liquidity: bigint } | null {
    for (const log of receipt.logs) {
      try {
        const parsed = gateway.interface.parseLog(log);
        if (parsed?.name === "LiquidityIncreased") {
          return { liquidity: parsed.args.liquidity };
        }
      } catch {
        // Not a gateway event
      }
    }
    return null;
  }

  function findLiquidityRemovedEvent(receipt: any): boolean {
    return receipt.logs.some((log: any) => {
      try {
        return gateway.interface.parseLog(log)?.name === "LiquidityRemoved";
      } catch {
        return false;
      }
    });
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

    console.log(`  JUSD: ${ethers.formatUnits(jusdBal, 6)}`);
    console.log(`  WcBTC: ${ethers.formatUnits(wcbtcBal, 8)}`);
    console.log(`  cBTC: ${ethers.formatUnits(cbtcBal, 8)}\n`);
  });

  describe("1. JUSD -> WcBTC", function () {
    it("Should swap JUSD for WcBTC (JUSD->svJUSD conversion + pool swap)", async function () {
      const balance = await jusd.balanceOf(signerAddress);
      if (balance < JUSD_AMOUNT) this.skip();

      await ensureApproval(jusd, JUSD_AMOUNT);
      const wcbtcBefore = await wcbtc.balanceOf(signerAddress);

      console.log(`    Swapping ${ethers.formatUnits(JUSD_AMOUNT, 6)} JUSD -> WcBTC...`);
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

      const wcbtcAfter = await wcbtc.balanceOf(signerAddress);
      const received = wcbtcAfter - wcbtcBefore;
      console.log(`    Received: ${ethers.formatUnits(received, 8)} WcBTC`);

      expect(receipt.status).to.equal(1);
      expect(received).to.be.gt(0);
      expect(findSwapEvent(receipt)).to.be.true;
    });
  });

  describe("2. WcBTC -> JUSD", function () {
    it("Should swap WcBTC for JUSD (pool swap + svJUSD->JUSD conversion)", async function () {
      const balance = await wcbtc.balanceOf(signerAddress);
      if (balance < WCBTC_AMOUNT) this.skip();

      await ensureApproval(wcbtc, WCBTC_AMOUNT);
      const jusdBefore = await jusd.balanceOf(signerAddress);

      console.log(`    Swapping ${ethers.formatUnits(WCBTC_AMOUNT, 8)} WcBTC -> JUSD...`);
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

      const jusdAfter = await jusd.balanceOf(signerAddress);
      const received = jusdAfter - jusdBefore;
      console.log(`    Received: ${ethers.formatUnits(received, 6)} JUSD`);

      expect(receipt.status).to.equal(1);
      expect(received).to.be.gt(0);
      expect(findSwapEvent(receipt)).to.be.true;
    });
  });

  describe("3. Native cBTC -> JUSD", function () {
    it("Should swap native cBTC for JUSD (cBTC->WcBTC wrap + pool swap + svJUSD->JUSD)", async function () {
      const balance = await ethers.provider.getBalance(signerAddress);
      if (balance < CBTC_AMOUNT + ethers.parseEther("0.0005")) this.skip();

      const jusdBefore = await jusd.balanceOf(signerAddress);

      console.log(`    Swapping ${ethers.formatUnits(CBTC_AMOUNT, 8)} cBTC -> JUSD...`);
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
      const received = jusdAfter - jusdBefore;
      console.log(`    Received: ${ethers.formatUnits(received, 6)} JUSD`);

      expect(receipt.status).to.equal(1);
      expect(received).to.be.gt(0);
      expect(findSwapEvent(receipt)).to.be.true;
    });
  });

  describe("4. WcBTC -> JUICE", function () {
    it("Should swap WcBTC for JUICE (pool swap + svJUSD->JUSD + Equity.invest)", async function () {
      const balance = await wcbtc.balanceOf(signerAddress);
      if (balance < WCBTC_AMOUNT) this.skip();

      await ensureApproval(wcbtc, WCBTC_AMOUNT);
      const juiceBefore = await juice.balanceOf(signerAddress);

      console.log(`    Swapping ${ethers.formatUnits(WCBTC_AMOUNT, 8)} WcBTC -> JUICE...`);
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

      const juiceAfter = await juice.balanceOf(signerAddress);
      const received = juiceAfter - juiceBefore;
      console.log(`    Received: ${ethers.formatUnits(received, 18)} JUICE`);

      expect(receipt.status).to.equal(1);
      expect(received).to.be.gt(0);
      expect(findSwapEvent(receipt)).to.be.true;
    });
  });

  describe("5. Native cBTC -> JUICE", function () {
    it("Should swap native cBTC for JUICE (full conversion chain)", async function () {
      const balance = await ethers.provider.getBalance(signerAddress);
      if (balance < CBTC_AMOUNT + ethers.parseEther("0.0005")) this.skip();

      const juiceBefore = await juice.balanceOf(signerAddress);

      console.log(`    Swapping ${ethers.formatUnits(CBTC_AMOUNT, 8)} cBTC -> JUICE...`);
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
      const received = juiceAfter - juiceBefore;
      console.log(`    Received: ${ethers.formatUnits(received, 18)} JUICE`);

      expect(receipt.status).to.equal(1);
      expect(received).to.be.gt(0);
      expect(findSwapEvent(receipt)).to.be.true;
    });
  });

  describe("6. Liquidity Lifecycle", function () {
    let positionTokenId: bigint;

    it("6a. Should add liquidity with JUSD + WcBTC", async function () {
      const jusdBalance = await jusd.balanceOf(signerAddress);
      const wcbtcBalance = await wcbtc.balanceOf(signerAddress);

      // Use larger amounts for liquidity (10 JUSD + 0.0001 WcBTC)
      const jusdAmount = 10_000_000n; // 10 JUSD (6 decimals)
      const wcbtcAmount = 10_000n; // 0.0001 WcBTC (8 decimals)

      if (jusdBalance < jusdAmount || wcbtcBalance < wcbtcAmount) {
        console.log(`    Skipping: Insufficient balance (need 10 JUSD and 0.0001 WcBTC)`);
        this.skip();
      }

      await ensureApproval(jusd, jusdAmount);
      await ensureApproval(wcbtc, wcbtcAmount);

      console.log(`    Adding liquidity: ${ethers.formatUnits(jusdAmount, 6)} JUSD + ${ethers.formatUnits(wcbtcAmount, 8)} WcBTC...`);
      const tx = await gateway.addLiquidity(
        ADDRESSES.JUSD,
        ADDRESSES.WcBTC,
        FEE,
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
    });

    it("6b. Should increase liquidity on existing position", async function () {
      if (!positionTokenId) {
        console.log(`    Skipping: No position from 6a`);
        this.skip();
      }

      const jusdBalance = await jusd.balanceOf(signerAddress);
      const wcbtcBalance = await wcbtc.balanceOf(signerAddress);

      const jusdAmount = 5_000_000n; // 5 JUSD
      const wcbtcAmount = 5_000n; // 0.00005 WcBTC

      if (jusdBalance < jusdAmount || wcbtcBalance < wcbtcAmount) {
        console.log(`    Skipping: Insufficient balance for increase`);
        this.skip();
      }

      const liquidityBefore = await getPositionLiquidity(positionTokenId);

      // Approve NFT to gateway
      await ensureNFTApproval(positionTokenId);
      await ensureApproval(jusd, jusdAmount);
      await ensureApproval(wcbtc, wcbtcAmount);

      console.log(`    Increasing liquidity: +${ethers.formatUnits(jusdAmount, 6)} JUSD + ${ethers.formatUnits(wcbtcAmount, 8)} WcBTC...`);
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

      // Verify NFT returned to user
      const owner = await positionManager.ownerOf(positionTokenId);
      expect(owner).to.equal(signerAddress);

      const liquidityAfter = await getPositionLiquidity(positionTokenId);
      console.log(`    Position liquidity: ${liquidityBefore} -> ${liquidityAfter}`);
      expect(liquidityAfter).to.be.gt(liquidityBefore);
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
      expect(findLiquidityRemovedEvent(receipt)).to.be.true;

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
      console.log(`    Received: ${ethers.formatUnits(jusdAfter - jusdBefore, 6)} JUSD, ${ethers.formatUnits(wcbtcAfter - wcbtcBefore, 8)} WcBTC`);
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
      expect(findLiquidityRemovedEvent(receipt)).to.be.true;

      // Verify all liquidity was removed from position
      const liquidityAfter = await getPositionLiquidity(positionTokenId);
      expect(liquidityAfter).to.equal(0n);

      // Verify tokens received (check each individually since they have different decimals)
      const jusdAfter = await jusd.balanceOf(signerAddress);
      const wcbtcAfter = await wcbtc.balanceOf(signerAddress);
      console.log(`    Received: ${ethers.formatUnits(jusdAfter - jusdBefore, 6)} JUSD, ${ethers.formatUnits(wcbtcAfter - wcbtcBefore, 8)} WcBTC`);
      expect(jusdAfter).to.be.gt(jusdBefore);
      expect(wcbtcAfter).to.be.gt(wcbtcBefore);
    });
  });

  describe("7. Liquidity Lifecycle with Native cBTC", function () {
    let positionTokenId: bigint;

    it("7a. Should add liquidity with native cBTC + JUSD", async function () {
      const cbtcBalance = await ethers.provider.getBalance(signerAddress);
      const jusdBalance = await jusd.balanceOf(signerAddress);

      const cbtcAmount = 10_000n; // 0.0001 cBTC (8 decimals)
      const jusdAmount = 10_000_000n; // 10 JUSD (6 decimals)

      if (cbtcBalance < cbtcAmount + ethers.parseEther("0.0005") || jusdBalance < jusdAmount) {
        console.log(`    Skipping: Insufficient balance (need 0.0001 cBTC and 10 JUSD)`);
        this.skip();
      }

      // Only approve JUSD (cBTC sent as value)
      await ensureApproval(jusd, jusdAmount);

      console.log(`    Adding liquidity: ${ethers.formatUnits(jusdAmount, 6)} JUSD + ${ethers.formatUnits(cbtcAmount, 8)} native cBTC...`);
      const tx = await gateway.addLiquidity(
        ADDRESSES.JUSD,
        ethers.ZeroAddress, // native cBTC
        FEE,
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
    });

    it("7b. Should increase liquidity with native cBTC on position from 7a", async function () {
      if (!positionTokenId) {
        console.log(`    Skipping: No position from 7a`);
        this.skip();
      }

      const cbtcBalance = await ethers.provider.getBalance(signerAddress);
      const jusdBalance = await jusd.balanceOf(signerAddress);

      const cbtcAmount = 5_000n; // 0.00005 cBTC (8 decimals)
      const jusdAmount = 5_000_000n; // 5 JUSD (6 decimals)

      if (cbtcBalance < cbtcAmount + ethers.parseEther("0.0005") || jusdBalance < jusdAmount) {
        console.log(`    Skipping: Insufficient balance for increase`);
        this.skip();
      }

      const liquidityBefore = await getPositionLiquidity(positionTokenId);

      // Approve NFT to gateway
      await ensureNFTApproval(positionTokenId);
      // Only approve JUSD (cBTC sent as value)
      await ensureApproval(jusd, jusdAmount);

      console.log(`    Increasing liquidity: +${ethers.formatUnits(jusdAmount, 6)} JUSD + ${ethers.formatUnits(cbtcAmount, 8)} native cBTC...`);
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

      // Verify NFT returned to user
      const owner = await positionManager.ownerOf(positionTokenId);
      expect(owner).to.equal(signerAddress);

      const liquidityAfter = await getPositionLiquidity(positionTokenId);
      console.log(`    Position liquidity: ${liquidityBefore} -> ${liquidityAfter}`);
      expect(liquidityAfter).to.be.gt(liquidityBefore);
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

      const cbtcBefore = await ethers.provider.getBalance(signerAddress);
      const jusdBefore = await jusd.balanceOf(signerAddress);

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
      expect(findLiquidityRemovedEvent(receipt)).to.be.true;

      // Verify all liquidity was removed from position
      const liquidityAfter = await getPositionLiquidity(positionTokenId);
      expect(liquidityAfter).to.equal(0n);

      // Calculate gas cost to accurately check cBTC received
      const gasCost = BigInt(receipt.gasUsed) * BigInt(receipt.gasPrice);

      // Verify tokens received
      const cbtcAfter = await ethers.provider.getBalance(signerAddress);
      const jusdAfter = await jusd.balanceOf(signerAddress);

      // cBTC balance should increase (minus gas cost)
      const cbtcReceived = cbtcAfter - cbtcBefore + gasCost;
      console.log(`    Received: ${ethers.formatUnits(jusdAfter - jusdBefore, 6)} JUSD, ${ethers.formatUnits(cbtcReceived, 8)} native cBTC`);

      expect(cbtcReceived).to.be.gt(0);
      expect(jusdAfter).to.be.gt(jusdBefore);
    });
  });
});
