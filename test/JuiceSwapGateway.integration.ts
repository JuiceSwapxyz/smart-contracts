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
};

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
];

const GATEWAY_ABI = [
  "function swapExactTokensForTokens(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 minAmountOut, address to, uint256 deadline) payable returns (uint256)",
  "event SwapExecuted(address indexed user, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)",
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
});
