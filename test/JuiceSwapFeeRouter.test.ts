import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const BRIDGE = "contracts/test/MockSwapRouters.sol:MockFeeRouterBridge";

describe("JuiceSwapFeeRouter (strict: every swap pays JUSD-fee)", () => {
  async function deployFixture() {
    const [deployer, governor, user, feeCollector, attacker] =
      await ethers.getSigners();

    const ERC20 = await ethers.getContractFactory("MockERC20");
    const usdce = await ERC20.deploy("USDCe", "USDC.e", 6);
    const ctusd = await ERC20.deploy("ctUSD", "ctUSD", 6);
    const jusd = await ERC20.deploy("JUSD", "JUSD", 18);

    // MockWETH is the existing WETH9-style mock; serves as WCBTC.
    const Wcbtc = await ethers.getContractFactory("MockWETH");
    const wcbtc = await Wcbtc.deploy("Wrapped cBTC", "WCBTC");

    const Algebra = await ethers.getContractFactory("MockAlgebraSwapRouter");
    const algebra = await Algebra.deploy();
    const V3 = await ethers.getContractFactory("MockV3SwapRouter");
    const v3 = await V3.deploy();

    const Factory = await ethers.getContractFactory("MockUniV3Factory");
    const v3Factory = await Factory.deploy(await deployer.getAddress());

    const Bridge = await ethers.getContractFactory(BRIDGE);
    const usdceBridge = await Bridge.deploy(
      await usdce.getAddress(),
      await jusd.getAddress(),
      ethers.parseUnits("1", 12), // 6 → 18 dec scale
    );
    const ctusdBridge = await Bridge.deploy(
      await ctusd.getAddress(),
      await jusd.getAddress(),
      ethers.parseUnits("1", 12),
    );

    const FR = await ethers.getContractFactory("JuiceSwapFeeRouter");
    const router = await FR.deploy({
      feeCollector: await feeCollector.getAddress(),
      satsumaRouter: await algebra.getAddress(),
      juiceswapRouter: await v3.getAddress(),
      juiceswapFactory: await v3Factory.getAddress(),
      governor: await governor.getAddress(),
      jusd: await jusd.getAddress(),
      usdce: await usdce.getAddress(),
      usdceBridge: await usdceBridge.getAddress(),
      ctusd: await ctusd.getAddress(),
      ctusdBridge: await ctusdBridge.getAddress(),
      wcbtc: await wcbtc.getAddress(),
    });

    // Pre-fund mock routers with output liquidity for both token kinds.
    const fill = async (token: any) => {
      await token.mint(await algebra.getAddress(), ethers.parseUnits("1000000", 18));
      await token.mint(await v3.getAddress(), ethers.parseUnits("1000000", 18));
    };
    await fill(usdce);
    await fill(ctusd);
    await fill(jusd);

    // WCBTC: prefund routers by depositing native value.
    await wcbtc
      .connect(deployer)
      .deposit({ value: ethers.parseEther("10") })
      .then(async () => wcbtc.transfer(await algebra.getAddress(), ethers.parseEther("5")));
    await wcbtc
      .connect(deployer)
      .deposit({ value: ethers.parseEther("10") })
      .then(async () => wcbtc.transfer(await v3.getAddress(), ethers.parseEther("5")));

    // Pre-fund users
    const giveUser = async (token: any, dec: number) => {
      await token.mint(await user.getAddress(), ethers.parseUnits("10000", dec));
    };
    await giveUser(usdce, 6);
    await giveUser(ctusd, 6);
    await giveUser(jusd, 18);
    await wcbtc.connect(user).deposit({ value: ethers.parseEther("5") });

    return {
      router, usdce, ctusd, jusd, wcbtc,
      usdceBridge, ctusdBridge, algebra, v3, v3Factory,
      governor, user, feeCollector, attacker, deployer,
    };
  }

  describe("Construction validation", () => {
    it("rejects JUSD with non-18 decimals (A3)", async () => {
      const [deployer, gov] = await ethers.getSigners();
      const ERC20 = await ethers.getContractFactory("MockERC20");
      const badJusd = await ERC20.deploy("J", "J", 6); // wrong decimals
      const usdce = await ERC20.deploy("U", "U", 6);
      const ctusd = await ERC20.deploy("C", "C", 6);
      const Bridge = await ethers.getContractFactory(BRIDGE);
      const ub = await Bridge.deploy(await usdce.getAddress(), await badJusd.getAddress(), 1);
      const cb = await Bridge.deploy(await ctusd.getAddress(), await badJusd.getAddress(), 1);
      const Algebra = await ethers.getContractFactory("MockAlgebraSwapRouter");
      const a = await Algebra.deploy();
      const V3 = await ethers.getContractFactory("MockV3SwapRouter");
      const v = await V3.deploy();
      const W = await ethers.getContractFactory("MockWETH");
      const w = await W.deploy("W", "W");
      const F = await ethers.getContractFactory("MockUniV3Factory");
      const f = await F.deploy(await deployer.getAddress());
      const FR = await ethers.getContractFactory("JuiceSwapFeeRouter");
      await expect(FR.deploy({
        feeCollector: await deployer.getAddress(),
        satsumaRouter: await a.getAddress(),
        juiceswapRouter: await v.getAddress(),
        juiceswapFactory: await f.getAddress(),
        governor: await gov.getAddress(),
        jusd: await badJusd.getAddress(),
        usdce: await usdce.getAddress(),
        usdceBridge: await ub.getAddress(),
        ctusd: await ctusd.getAddress(),
        ctusdBridge: await cb.getAddress(),
        wcbtc: await w.getAddress(),
      })).to.be.revertedWithCustomError(FR, "BadDecimals");
    });

    it("rejects bridge that points at the wrong source token (A2)", async () => {
      const [deployer, gov] = await ethers.getSigners();
      const ERC20 = await ethers.getContractFactory("MockERC20");
      const jusd = await ERC20.deploy("J", "J", 18);
      const usdce = await ERC20.deploy("U", "U", 6);
      const ctusd = await ERC20.deploy("C", "C", 6);
      const Bridge = await ethers.getContractFactory(BRIDGE);
      // wire usdceBridge.source = ctusd → mismatch
      const ub = await Bridge.deploy(await ctusd.getAddress(), await jusd.getAddress(), 1);
      const cb = await Bridge.deploy(await ctusd.getAddress(), await jusd.getAddress(), 1);
      const Algebra = await ethers.getContractFactory("MockAlgebraSwapRouter");
      const a = await Algebra.deploy();
      const V3 = await ethers.getContractFactory("MockV3SwapRouter");
      const v = await V3.deploy();
      const W = await ethers.getContractFactory("MockWETH");
      const w = await W.deploy("W", "W");
      const F = await ethers.getContractFactory("MockUniV3Factory");
      const f = await F.deploy(await deployer.getAddress());
      const FR = await ethers.getContractFactory("JuiceSwapFeeRouter");
      await expect(FR.deploy({
        feeCollector: await deployer.getAddress(),
        satsumaRouter: await a.getAddress(),
        juiceswapRouter: await v.getAddress(),
        juiceswapFactory: await f.getAddress(),
        governor: await gov.getAddress(),
        jusd: await jusd.getAddress(),
        usdce: await usdce.getAddress(),
        usdceBridge: await ub.getAddress(),
        ctusd: await ctusd.getAddress(),
        ctusdBridge: await cb.getAddress(),
        wcbtc: await w.getAddress(),
      })).to.be.revertedWithCustomError(FR, "BridgeMismatch");
    });

    it("B1: max-allowance survives a swap (no per-tx approve/clear cycle)", async () => {
      const { router, usdce, ctusd, algebra, user } = await loadFixture(deployFixture);
      const amountIn = ethers.parseUnits("100", 6);
      await usdce.connect(user).approve(await router.getAddress(), amountIn);
      await router.connect(user).swapExactInputSingleSatsuma(
        await usdce.getAddress(), await ctusd.getAddress(),
        ethers.ZeroAddress, amountIn, 0, 0,
        Math.floor(Date.now() / 1000) + 600,
      false,
      );
      // After the swap, allowance(router, algebra) for USDC.e should
      // still be (approximately) max — the helper skipped the SSTORE.
      const allow = await usdce.allowance(await router.getAddress(), await algebra.getAddress());
      // Subtract the swapAmount consumed: max - swapAmount (since
      // standard ERC20 decrements allowance on transferFrom).
      // For the mock token, MockERC20 from OpenZeppelin ERC20 decrements
      // allowance unless infinite — for max value, OZ skips the decrement.
      // So we expect == MaxUint256.
      expect(allow).to.equal(ethers.MaxUint256);
    });

    it("B1: max-approvals are set in constructor", async () => {
      const { router, usdce, ctusd, jusd, usdceBridge, ctusdBridge, algebra, v3 } =
        await loadFixture(deployFixture);
      const MAX = ethers.MaxUint256;
      expect(await usdce.allowance(await router.getAddress(), await usdceBridge.getAddress())).to.equal(MAX);
      expect(await ctusd.allowance(await router.getAddress(), await ctusdBridge.getAddress())).to.equal(MAX);
      expect(await usdce.allowance(await router.getAddress(), await algebra.getAddress())).to.equal(MAX);
      expect(await usdce.allowance(await router.getAddress(), await v3.getAddress())).to.equal(MAX);
      expect(await ctusd.allowance(await router.getAddress(), await algebra.getAddress())).to.equal(MAX);
      expect(await ctusd.allowance(await router.getAddress(), await v3.getAddress())).to.equal(MAX);
      expect(await jusd.allowance(await router.getAddress(), await algebra.getAddress())).to.equal(MAX);
      expect(await jusd.allowance(await router.getAddress(), await v3.getAddress())).to.equal(MAX);
    });
  });

  describe("Input-side fee (Satsuma USDC.e → ctUSD)", () => {
    it("fee taken in USDC.e, bridged to JUSD into collector", async () => {
      const { router, usdce, ctusd, jusd, user, feeCollector } =
        await loadFixture(deployFixture);
      const amountIn = ethers.parseUnits("1000", 6);
      await usdce.connect(user).approve(await router.getAddress(), amountIn);
      const before = await jusd.balanceOf(await feeCollector.getAddress());
      await router.connect(user).swapExactInputSingleSatsuma(
        await usdce.getAddress(), await ctusd.getAddress(),
        ethers.ZeroAddress, amountIn, 0, 0,
        Math.floor(Date.now() / 1000) + 600,
      false,
      );
      const fee = (amountIn * 25n) / 10000n;
      expect(await jusd.balanceOf(await feeCollector.getAddress()) - before)
        .to.equal(fee * 10n ** 12n);
      expect(await usdce.balanceOf(await feeCollector.getAddress())).to.equal(0);
    });
  });

  describe("Output-side fee (input not bridgeable, output bridgeable)", () => {
    it("WCBTC → ctUSD: fee taken on output (ctUSD), bridged to JUSD", async () => {
      const { router, wcbtc, ctusd, jusd, user, feeCollector } =
        await loadFixture(deployFixture);
      const amountIn = ethers.parseUnits("1", 8);
      await wcbtc.connect(user).approve(await router.getAddress(), amountIn);
      const userOutBefore = await ctusd.balanceOf(await user.getAddress());
      const colJusdBefore = await jusd.balanceOf(await feeCollector.getAddress());

      // 1:1 mock router. WCBTC has 8 decimals, ctUSD has 6 — the mock
      // doesn't scale so we just look at the raw amountIn → amountOut.
      // After the swap, output (in ctUSD raw units = amountIn = 1e8) is
      // skimmed by 0.25% and that fee is bridged.
      await router.connect(user).swapExactInputSingleSatsuma(
        await wcbtc.getAddress(), await ctusd.getAddress(),
        ethers.ZeroAddress, amountIn, 0, 0,
        Math.floor(Date.now() / 1000) + 600,
      false,
      );
      const fee = (amountIn * 25n) / 10000n;
      // ctUSD is 6-decimal; bridge scales by 1e12 to 18-decimal JUSD.
      expect(await jusd.balanceOf(await feeCollector.getAddress()) - colJusdBefore)
        .to.equal(fee * 10n ** 12n);
      // User got (amountIn - fee) ctUSD
      expect(await ctusd.balanceOf(await user.getAddress()) - userOutBefore)
        .to.equal(amountIn - fee);
      // No raw WCBTC or ctUSD parked at the collector
      expect(await wcbtc.balanceOf(await feeCollector.getAddress())).to.equal(0);
      expect(await ctusd.balanceOf(await feeCollector.getAddress())).to.equal(0);
    });
  });

  describe("Neither side bridgeable → revert NoFeePath", () => {
    it("rejects WCBTC → WCBTC swap when route fee is active", async () => {
      const { router, wcbtc, user } = await loadFixture(deployFixture);
      const amountIn = ethers.parseUnits("1", 8);
      await wcbtc.connect(user).approve(await router.getAddress(), amountIn);
      await expect(
        router.connect(user).swapExactInputSingleSatsuma(
          await wcbtc.getAddress(), await wcbtc.getAddress(),
          ethers.ZeroAddress, amountIn, 0, 0,
          Math.floor(Date.now() / 1000) + 600,
          false,
        ),
      ).to.be.revertedWithCustomError(router, "NoFeePath");
    });

    it("allows WCBTC → WCBTC when fee is disabled (governance escape)", async () => {
      const { router, wcbtc, user, governor } = await loadFixture(deployFixture);
      await router.connect(governor).setFeeBps(0);
      const amountIn = ethers.parseUnits("1", 8);
      await wcbtc.connect(user).approve(await router.getAddress(), amountIn);
      await router.connect(user).swapExactInputSingleSatsuma(
        await wcbtc.getAddress(), await wcbtc.getAddress(),
        ethers.ZeroAddress, amountIn, 0, 0,
        Math.floor(Date.now() / 1000) + 600,
      false,
      );
    });
  });

  describe("JUSD as fee token (no bridge needed)", () => {
    it("input JUSD: fee transfered direct, no bridge call", async () => {
      const { router, jusd, ctusd, user, feeCollector } = await loadFixture(deployFixture);
      const amountIn = ethers.parseUnits("100", 18);
      await jusd.connect(user).approve(await router.getAddress(), amountIn);
      const before = await jusd.balanceOf(await feeCollector.getAddress());
      await router.connect(user).swapExactInputSingleSatsuma(
        await jusd.getAddress(), await ctusd.getAddress(),
        ethers.ZeroAddress, amountIn, 0, 0,
        Math.floor(Date.now() / 1000) + 600,
      false,
      );
      // 0.25% in JUSD itself.
      expect(await jusd.balanceOf(await feeCollector.getAddress()) - before)
        .to.equal((amountIn * 25n) / 10000n);
    });
  });

  describe("Bridge stopped", () => {
    it("reverts BridgeStopped when bridge is paused", async () => {
      const { router, usdce, ctusd, usdceBridge, user } = await loadFixture(deployFixture);
      await usdceBridge.setStopped(true);
      const amountIn = ethers.parseUnits("100", 6);
      await usdce.connect(user).approve(await router.getAddress(), amountIn);
      await expect(
        router.connect(user).swapExactInputSingleSatsuma(
          await usdce.getAddress(), await ctusd.getAddress(),
          ethers.ZeroAddress, amountIn, 0, 0,
          Math.floor(Date.now() / 1000) + 600,
          false,
        ),
      ).to.be.revertedWithCustomError(router, "BridgeStopped");
    });

    it("escape: governance can setFeeBps(0) to bypass bridge during outage", async () => {
      const { router, usdce, ctusd, usdceBridge, user, governor, feeCollector, jusd } =
        await loadFixture(deployFixture);
      await usdceBridge.setStopped(true);
      await router.connect(governor).setFeeBps(0);
      const amountIn = ethers.parseUnits("100", 6);
      await usdce.connect(user).approve(await router.getAddress(), amountIn);
      const before = await jusd.balanceOf(await feeCollector.getAddress());
      await router.connect(user).swapExactInputSingleSatsuma(
        await usdce.getAddress(), await ctusd.getAddress(),
        ethers.ZeroAddress, amountIn, 0, 0,
        Math.floor(Date.now() / 1000) + 600,
      false,
      );
      // No fee accrued.
      expect(await jusd.balanceOf(await feeCollector.getAddress())).to.equal(before);
    });
  });

  describe("Caps + governance", () => {
    it("hard-cap at MAX_FEE_BPS (501 reverts)", async () => {
      const { router, governor } = await loadFixture(deployFixture);
      await expect(router.connect(governor).setFeeBps(501))
        .to.be.revertedWithCustomError(router, "FeeAboveCap");
    });

    it("governor can set fee anywhere in [0, 500]", async () => {
      const { router, governor } = await loadFixture(deployFixture);
      for (const v of [0, 1, 25, 250, 500]) {
        await router.connect(governor).setFeeBps(v);
        expect(await router.feeBps()).to.equal(v);
      }
    });

    it("non-governor cannot change fee", async () => {
      const { router, attacker } = await loadFixture(deployFixture);
      await expect(router.connect(attacker).setFeeBps(100))
        .to.be.revertedWithCustomError(router, "OwnableUnauthorizedAccount");
    });

    it("JuiceSwap-V3 route fee starts OFF, DAO can flip", async () => {
      const { router, governor } = await loadFixture(deployFixture);
      expect(await router.feeEnabled(1)).to.equal(false);
      await router.connect(governor).setRouteFeeEnabled(1, true);
      expect(await router.feeEnabled(1)).to.equal(true);
    });
  });

  describe("Native cBTC support (B2)", () => {
    it("native cBTC → USDC.e (msg.value path): wraps + output-side fee in USDC.e", async () => {
      const { router, wcbtc, usdce, jusd, user, feeCollector } =
        await loadFixture(deployFixture);
      // Enable JuiceSwap V3 route fee for this test (so we have a fee to verify).
      const [, governor] = await ethers.getSigners();
      await router.connect(governor).setRouteFeeEnabled(1, true);

      const amountIn = ethers.parseEther("1"); // 1 native cBTC = 1e18 wei
      const colJusdBefore = await jusd.balanceOf(await feeCollector.getAddress());
      const userUsdceBefore = await usdce.balanceOf(await user.getAddress());

      await router.connect(user).swapExactInputSingleJuiceSwap(
        await wcbtc.getAddress(),
        await usdce.getAddress(),
        3000,
        amountIn,
        0,
        0,
        Math.floor(Date.now() / 1000) + 600,
        false,
        { value: amountIn },
      );

      // 1:1 mock; output = 1e18 USDC.e raw units (mock doesn't scale decimals).
      // 0.25% fee on output → 0.0025e18 fee → bridged with 1e12 scale to JUSD.
      const fee = (amountIn * 25n) / 10000n;
      expect(await jusd.balanceOf(await feeCollector.getAddress()) - colJusdBefore)
        .to.equal(fee * 10n ** 12n);
      expect(await usdce.balanceOf(await user.getAddress()) - userUsdceBefore)
        .to.equal(amountIn - fee);
    });

    it("USDC.e → native cBTC (unwrapNative=true): input-side fee + native delivered", async () => {
      const { router, usdce, wcbtc, jusd, user, feeCollector } =
        await loadFixture(deployFixture);
      const [, governor] = await ethers.getSigners();
      await router.connect(governor).setRouteFeeEnabled(1, true);

      const amountIn = ethers.parseUnits("1000", 6);
      await usdce.connect(user).approve(await router.getAddress(), amountIn);

      const userEthBefore = await ethers.provider.getBalance(await user.getAddress());
      const colJusdBefore = await jusd.balanceOf(await feeCollector.getAddress());

      const tx = await router.connect(user).swapExactInputSingleJuiceSwap(
        await usdce.getAddress(),
        await wcbtc.getAddress(),
        3000,
        amountIn,
        0,
        0,
        Math.floor(Date.now() / 1000) + 600,
        true,
      );
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;

      const fee = (amountIn * 25n) / 10000n;
      // 1:1 mock: user gets (amountIn - fee) WCBTC raw units. With WCBTC=18 dec
      // and amountIn=1000 USDC.e (6 dec), the raw quantity is 1e9 — small but
      // exact for the assertion. Note this is a mock artefact, not realistic.
      expect(await jusd.balanceOf(await feeCollector.getAddress()) - colJusdBefore)
        .to.equal(fee * 10n ** 12n);
      const userEthAfter = await ethers.provider.getBalance(await user.getAddress());
      const native = userEthAfter - userEthBefore + gasCost;
      expect(native).to.equal(amountIn - fee);
      // No WCBTC left at the router or user.
      expect(await wcbtc.balanceOf(await router.getAddress())).to.equal(0);
      expect(await wcbtc.balanceOf(await user.getAddress())).to.equal(
        ethers.parseEther("5"),
      );
    });

    it("rejects msg.value when tokenIn != WCBTC", async () => {
      const { router, usdce, ctusd, user } = await loadFixture(deployFixture);
      const amountIn = ethers.parseUnits("100", 6);
      await usdce.connect(user).approve(await router.getAddress(), amountIn);
      await expect(
        router.connect(user).swapExactInputSingleSatsuma(
          await usdce.getAddress(),
          await ctusd.getAddress(),
          ethers.ZeroAddress,
          amountIn,
          0,
          0,
          Math.floor(Date.now() / 1000) + 600,
          false,
          { value: 1 },
        ),
      ).to.be.revertedWithCustomError(router, "NativeOnlyWithWCBTC");
    });

    it("rejects msg.value mismatch", async () => {
      const { router, wcbtc, usdce, user, governor } = await loadFixture(deployFixture);
      await router.connect(governor).setRouteFeeEnabled(1, true);
      const amountIn = ethers.parseEther("1");
      await expect(
        router.connect(user).swapExactInputSingleJuiceSwap(
          await wcbtc.getAddress(),
          await usdce.getAddress(),
          3000,
          amountIn,
          0,
          0,
          Math.floor(Date.now() / 1000) + 600,
          false,
          { value: amountIn / 2n },
        ),
      ).to.be.revertedWithCustomError(router, "NativeValueMismatch");
    });

    it("rejects unwrapNative when tokenOut != WCBTC", async () => {
      const { router, usdce, ctusd, user } = await loadFixture(deployFixture);
      const amountIn = ethers.parseUnits("100", 6);
      await usdce.connect(user).approve(await router.getAddress(), amountIn);
      await expect(
        router.connect(user).swapExactInputSingleSatsuma(
          await usdce.getAddress(),
          await ctusd.getAddress(),
          ethers.ZeroAddress,
          amountIn,
          0,
          0,
          Math.floor(Date.now() / 1000) + 600,
          true, // unwrapNative — but ctUSD is not WCBTC
        ),
      ).to.be.revertedWithCustomError(router, "UnwrapOnlyForWCBTC");
    });

    it("receive() rejects native value from non-WCBTC sender", async () => {
      const { router, attacker } = await loadFixture(deployFixture);
      await expect(
        attacker.sendTransaction({
          to: await router.getAddress(),
          value: ethers.parseEther("0.01"),
        }),
      ).to.be.revertedWithCustomError(router, "NativeOnlyWithWCBTC");
    });
  });

  describe("Accumulate + convert non-bridgeable tokens (DAO-driven)", () => {
    // Helper: encode a single-hop V3 path token→fee→tokenOut
    function encodeV3Path(tokenA: string, fee: number, tokenB: string): string {
      const a = tokenA.replace(/^0x/, "").padStart(40, "0");
      const f = fee.toString(16).padStart(6, "0");
      const b = tokenB.replace(/^0x/, "").padStart(40, "0");
      return "0x" + a + f + b;
    }

    it("setConversionPath rejects path that doesn't end in JUSD", async () => {
      const { router, wcbtc, usdce, governor } = await loadFixture(deployFixture);
      const bad = encodeV3Path(await wcbtc.getAddress(), 3000, await usdce.getAddress());
      await expect(router.connect(governor).setConversionPath(await wcbtc.getAddress(), bad))
        .to.be.revertedWithCustomError(router, "PathMustEndInJusd");
    });

    it("setConversionPath rejects path that doesn't start with token", async () => {
      const { router, wcbtc, usdce, jusd, governor } = await loadFixture(deployFixture);
      // Path starts with usdce, not wcbtc.
      const bad = encodeV3Path(await usdce.getAddress(), 3000, await jusd.getAddress());
      await expect(router.connect(governor).setConversionPath(await wcbtc.getAddress(), bad))
        .to.be.revertedWithCustomError(router, "PathTooShort");
    });

    it("setConversionPath(token=JUSD) reverts", async () => {
      const { router, jusd, governor } = await loadFixture(deployFixture);
      const p = encodeV3Path(await jusd.getAddress(), 3000, await jusd.getAddress());
      await expect(router.connect(governor).setConversionPath(await jusd.getAddress(), p))
        .to.be.revertedWithCustomError(router, "CannotConvertJusd");
    });

    it("WCBTC → JUICE (neither bridgeable): without path → NoFeePath", async () => {
      const { router, wcbtc, user, governor } = await loadFixture(deployFixture);
      // Fake JUICE as a generic ERC20 not in the whitelist.
      const ERC20 = await ethers.getContractFactory("MockERC20");
      const juice = await ERC20.deploy("JUICE", "JUICE", 18);
      await juice.mint(await router.SATSUMA_ROUTER(), ethers.parseEther("1000"));
      // Enable JuiceSwap V3 route fee.
      await router.connect(governor).setRouteFeeEnabled(1, true);

      const amountIn = ethers.parseEther("0.1");
      await wcbtc.connect(user).approve(await router.getAddress(), amountIn);
      await expect(
        router.connect(user).swapExactInputSingleJuiceSwap(
          await wcbtc.getAddress(), await juice.getAddress(),
          3000, amountIn, 0, 0,
          Math.floor(Date.now() / 1000) + 600,
          false,
        ),
      ).to.be.revertedWithCustomError(router, "NoFeePath");
    });

    it("WCBTC → JUICE: with WCBTC path configured → fee accumulates in WCBTC", async () => {
      const { router, wcbtc, jusd, user, governor, feeCollector } =
        await loadFixture(deployFixture);
      const ERC20 = await ethers.getContractFactory("MockERC20");
      const juice = await ERC20.deploy("JUICE", "JUICE", 18);
      await juice.mint(await router.JUICESWAP_ROUTER(), ethers.parseEther("1000"));

      await router.connect(governor).setRouteFeeEnabled(1, true);
      const p = encodeV3Path(await wcbtc.getAddress(), 3000, await jusd.getAddress());
      await router.connect(governor).setConversionPath(await wcbtc.getAddress(), p);

      const amountIn = ethers.parseEther("0.1");
      await wcbtc.connect(user).approve(await router.getAddress(), amountIn);
      const tx = await router.connect(user).swapExactInputSingleJuiceSwap(
        await wcbtc.getAddress(), await juice.getAddress(),
        3000, amountIn, 0, 0,
        Math.floor(Date.now() / 1000) + 600,
        false,
      );

      const expectedFee = (amountIn * 25n) / 10000n;
      // WCBTC fee parked at the router; no JUSD at collector yet.
      expect(await wcbtc.balanceOf(await router.getAddress())).to.equal(expectedFee);
      expect(await jusd.balanceOf(await feeCollector.getAddress())).to.equal(0);
      await expect(tx).to.emit(router, "FeeAccumulated").withArgs(
        await wcbtc.getAddress(),
        expectedFee,
      );
    });

    it("convertAccumulated: WCBTC → JUSD via TWAP-protected path", async () => {
      const { router, wcbtc, jusd, user, governor, feeCollector, v3Factory } =
        await loadFixture(deployFixture);
      const ERC20 = await ethers.getContractFactory("MockERC20");
      const juice = await ERC20.deploy("JUICE", "JUICE", 18);
      await juice.mint(await router.JUICESWAP_ROUTER(), ethers.parseEther("1000"));
      await jusd.mint(await router.JUICESWAP_ROUTER(), ethers.parseEther("1000000"));

      // Set up the WCBTC/JUSD V3 pool mock with tick=0 (1:1) + enough cardinality.
      const Pool = await ethers.getContractFactory("MockUniV3Pool");
      const pool = await Pool.deploy(
        await v3Factory.getAddress(),
        await wcbtc.getAddress(),
        await jusd.getAddress(),
      );
      // tick 0 ≈ 1:1 quote regardless of decimals via getQuoteAtTick.
      await pool.setMockTwap(0, 1000);
      await v3Factory.setPool(
        await wcbtc.getAddress(),
        await jusd.getAddress(),
        3000,
        await pool.getAddress(),
      );

      await router.connect(governor).setRouteFeeEnabled(1, true);
      const p = encodeV3Path(await wcbtc.getAddress(), 3000, await jusd.getAddress());
      await router.connect(governor).setConversionPath(await wcbtc.getAddress(), p);

      const amountIn = ethers.parseEther("0.1");
      await wcbtc.connect(user).approve(await router.getAddress(), amountIn);
      await router.connect(user).swapExactInputSingleJuiceSwap(
        await wcbtc.getAddress(), await juice.getAddress(),
        3000, amountIn, 0, 0,
        Math.floor(Date.now() / 1000) + 600,
        false,
      );

      const expectedFee = (amountIn * 25n) / 10000n;
      const before = await jusd.balanceOf(await feeCollector.getAddress());

      await router.connect(user).convertAccumulated(await wcbtc.getAddress());

      // 1:1 mock + tick=0 ⇒ TWAP-expected = balance, actual = balance.
      expect(await jusd.balanceOf(await feeCollector.getAddress()) - before)
        .to.equal(expectedFee);
      expect(await wcbtc.balanceOf(await router.getAddress())).to.equal(0);
    });

    it("convertAccumulated reverts when pool cardinality is insufficient", async () => {
      const { router, wcbtc, jusd, user, governor, v3Factory } =
        await loadFixture(deployFixture);
      const Pool = await ethers.getContractFactory("MockUniV3Pool");
      const pool = await Pool.deploy(
        await v3Factory.getAddress(),
        await wcbtc.getAddress(),
        await jusd.getAddress(),
      );
      // cardinality 5 ≪ required (1800/2 + 1 = 901).
      await pool.setMockTwap(0, 5);
      await v3Factory.setPool(
        await wcbtc.getAddress(), await jusd.getAddress(), 3000, await pool.getAddress(),
      );

      const p = encodeV3Path(await wcbtc.getAddress(), 3000, await jusd.getAddress());
      await router.connect(governor).setConversionPath(await wcbtc.getAddress(), p);
      // Park some WCBTC in the router as if from a fee accrual.
      await wcbtc.connect(user).transfer(await router.getAddress(), ethers.parseEther("0.01"));
      await expect(router.convertAccumulated(await wcbtc.getAddress()))
        .to.be.revertedWithCustomError(router, "InsufficientCardinality");
    });

    it("convertAccumulated reverts when pool doesn't exist", async () => {
      const { router, wcbtc, jusd, user, governor } = await loadFixture(deployFixture);
      const p = encodeV3Path(await wcbtc.getAddress(), 3000, await jusd.getAddress());
      await router.connect(governor).setConversionPath(await wcbtc.getAddress(), p);
      await wcbtc.connect(user).transfer(await router.getAddress(), ethers.parseEther("0.01"));
      await expect(router.convertAccumulated(await wcbtc.getAddress()))
        .to.be.revertedWithCustomError(router, "PoolDoesNotExist");
    });

    it("setTwapParams rejects invalid values", async () => {
      const { router, governor } = await loadFixture(deployFixture);
      await expect(router.connect(governor).setTwapParams(299, 2, 200))
        .to.be.revertedWithCustomError(router, "InvalidTwapParams");
      await expect(router.connect(governor).setTwapParams(1800, 0, 200))
        .to.be.revertedWithCustomError(router, "InvalidTwapParams");
      await expect(router.connect(governor).setTwapParams(1800, 2, 1001))
        .to.be.revertedWithCustomError(router, "InvalidTwapParams");
    });

    it("convertAccumulated honours minConvertAmount", async () => {
      const { router, wcbtc, jusd, governor } = await loadFixture(deployFixture);
      const p = encodeV3Path(await wcbtc.getAddress(), 3000, await jusd.getAddress());
      await router.connect(governor).setConversionPath(await wcbtc.getAddress(), p);
      await router.connect(governor).setMinConvertAmount(
        await wcbtc.getAddress(),
        ethers.parseEther("1"),
      );
      // Park a small amount in the router (≪ minConvertAmount)
      await wcbtc.connect(governor).deposit({ value: ethers.parseEther("0.01") });
      await wcbtc.connect(governor).transfer(
        await router.getAddress(),
        ethers.parseEther("0.01"),
      );
      await expect(router.convertAccumulated(await wcbtc.getAddress()))
        .to.be.revertedWithCustomError(router, "BelowMinConvert");
    });

    it("convertAccumulated(JUSD) reverts (no conversion needed)", async () => {
      const { router, jusd } = await loadFixture(deployFixture);
      await expect(router.convertAccumulated(await jusd.getAddress()))
        .to.be.revertedWithCustomError(router, "CannotConvertJusd");
    });

    it("convertAccumulated reverts when no path configured", async () => {
      const { router, wcbtc } = await loadFixture(deployFixture);
      await expect(router.convertAccumulated(await wcbtc.getAddress()))
        .to.be.revertedWithCustomError(router, "PathNotConfigured");
    });
  });

  describe("Security envelope (no setters for immutable anchors)", () => {
    it("no setter for FEE_COLLECTOR / bridges / routers / tokens", async () => {
      const { router } = await loadFixture(deployFixture);
      const banned = ["collector", "bridge", "router", "jusd", "usdc", "ctusd", "feerecipient"];
      for (const f of router.interface.fragments) {
        if (f.type !== "function") continue;
        const name = (f as any).name as string;
        const low = name.toLowerCase();
        if (!low.startsWith("set")) continue;
        for (const b of banned) {
          if (low.includes(b)) throw new Error(`Forbidden setter found: ${name}`);
        }
      }
    });
  });
});
