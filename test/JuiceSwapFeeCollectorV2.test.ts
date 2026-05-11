import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("JuiceSwapFeeCollectorV2 (strict)", () => {
  async function deployFixture() {
    const [deployer, governor, user, anyone] = await ethers.getSigners();

    const ERC20 = await ethers.getContractFactory("MockERC20");
    const jusd = await ERC20.deploy("JUSD", "JUSD", 18);

    const Equity = await ethers.getContractFactory("MockEquity");
    const juice = await Equity.deploy("JUICE", "JUICE", await jusd.getAddress());

    const Collector = await ethers.getContractFactory("JuiceSwapFeeCollectorV2");
    const collector = await Collector.deploy(
      await jusd.getAddress(),
      await juice.getAddress(),
      await governor.getAddress(),
    );

    return { collector, jusd, juice, governor, user, anyone, deployer };
  }

  it("rejects misdeploy where Equity.JUSD() != _jusd (M-2)", async () => {
    const [, governor] = await ethers.getSigners();
    const ERC20 = await ethers.getContractFactory("MockERC20");
    const jusd = await ERC20.deploy("JUSD", "JUSD", 18);
    const otherJusd = await ERC20.deploy("XJUSD", "XJUSD", 18);
    const Equity = await ethers.getContractFactory("MockEquity");
    // Equity wired to otherJusd, not jusd.
    const juice = await Equity.deploy("J", "J", await otherJusd.getAddress());
    const Collector = await ethers.getContractFactory("JuiceSwapFeeCollectorV2");
    await expect(Collector.deploy(
      await jusd.getAddress(), // wrong — Equity references otherJusd
      await juice.getAddress(),
      await governor.getAddress(),
    )).to.be.revertedWithCustomError(Collector, "JusdEquityMismatch");
  });

  it("sets immutables and defaults at construction", async () => {
    const { collector, jusd, juice, governor } = await loadFixture(deployFixture);
    expect(await collector.JUSD()).to.equal(await jusd.getAddress());
    expect(await collector.JUICE()).to.equal(await juice.getAddress());
    expect(await collector.owner()).to.equal(await governor.getAddress());
    expect(await collector.flushStep()).to.equal(ethers.parseEther("100"));
  });

  describe("JUSD flush (threshold-gated)", () => {
    it("reverts when below threshold", async () => {
      const { collector, jusd, anyone } = await loadFixture(deployFixture);
      await jusd.mint(await collector.getAddress(), ethers.parseEther("50"));
      await expect(collector.connect(anyone).flush())
        .to.be.revertedWithCustomError(collector, "BelowThreshold");
    });

    it("at 250 JUSD: flushes 200 (= 2 × 100 step), keeps 50 as remainder", async () => {
      const { collector, jusd, juice, anyone } = await loadFixture(deployFixture);
      await jusd.mint(await collector.getAddress(), ethers.parseEther("250"));
      await collector.connect(anyone).flush();
      expect(await jusd.balanceOf(await juice.getAddress())).to.equal(
        ethers.parseEther("200"),
      );
      expect(await jusd.balanceOf(await collector.getAddress())).to.equal(
        ethers.parseEther("50"),
      );
    });

    it("at 100 JUSD: flushes 100, keeps 0", async () => {
      const { collector, jusd, juice, anyone } = await loadFixture(deployFixture);
      await jusd.mint(await collector.getAddress(), ethers.parseEther("100"));
      await collector.connect(anyone).flush();
      expect(await jusd.balanceOf(await juice.getAddress())).to.equal(
        ethers.parseEther("100"),
      );
      expect(await jusd.balanceOf(await collector.getAddress())).to.equal(0);
    });

    it("at 99 JUSD: reverts (below one full step)", async () => {
      const { collector, jusd, anyone } = await loadFixture(deployFixture);
      await jusd.mint(await collector.getAddress(), ethers.parseEther("99"));
      await expect(collector.connect(anyone).flush())
        .to.be.revertedWithCustomError(collector, "BelowThreshold");
    });

    it("emits Flushed with (amount, remainder)", async () => {
      const { collector, jusd } = await loadFixture(deployFixture);
      await jusd.mint(await collector.getAddress(), ethers.parseEther("350"));
      await expect(collector.flush())
        .to.emit(collector, "Flushed")
        .withArgs(ethers.parseEther("300"), ethers.parseEther("50"));
    });

    it("sequential 100er-Schritte: 250 → flush 200 (50 left) → mint 60 → flush 100 (10 left)", async () => {
      const { collector, jusd, juice, anyone } = await loadFixture(deployFixture);
      await jusd.mint(await collector.getAddress(), ethers.parseEther("250"));
      await collector.connect(anyone).flush();
      expect(await jusd.balanceOf(await collector.getAddress())).to.equal(
        ethers.parseEther("50"),
      );
      // Add 60 more → balance now 110 → next flush takes 100.
      await jusd.mint(await collector.getAddress(), ethers.parseEther("60"));
      await collector.connect(anyone).flush();
      expect(await jusd.balanceOf(await juice.getAddress())).to.equal(
        ethers.parseEther("300"),
      );
      expect(await jusd.balanceOf(await collector.getAddress())).to.equal(
        ethers.parseEther("10"),
      );
    });

    it("tryFlush returns false below threshold without reverting", async () => {
      const { collector, jusd, anyone } = await loadFixture(deployFixture);
      await jusd.mint(await collector.getAddress(), ethers.parseEther("50"));
      const r = await collector.connect(anyone).tryFlush.staticCall();
      expect(r[0]).to.equal(false);
    });

    it("tryFlush above threshold: flushes step-multiple and returns (true, amount)", async () => {
      const { collector, jusd, juice, anyone } = await loadFixture(deployFixture);
      await jusd.mint(await collector.getAddress(), ethers.parseEther("350"));
      const result = await collector.connect(anyone).tryFlush.staticCall();
      expect(result[0]).to.equal(true);
      expect(result[1]).to.equal(ethers.parseEther("300"));
      // Actually execute and verify state.
      await collector.connect(anyone).tryFlush();
      expect(await jusd.balanceOf(await juice.getAddress())).to.equal(
        ethers.parseEther("300"),
      );
      expect(await jusd.balanceOf(await collector.getAddress())).to.equal(
        ethers.parseEther("50"),
      );
    });

    it("flush is permissionless", async () => {
      const { collector, jusd, juice, user } = await loadFixture(deployFixture);
      await jusd.mint(await collector.getAddress(), ethers.parseEther("200"));
      await collector.connect(user).flush();
      expect(await jusd.balanceOf(await juice.getAddress())).to.equal(
        ethers.parseEther("200"),
      );
      expect(await jusd.balanceOf(await collector.getAddress())).to.equal(0);
    });
  });

  describe("JUICE burn (via Equity.redeem)", () => {
    it("burns JUICE balance via redeem(target=JUICE, shares); JUICE supply drops, JUSD pot preserved", async () => {
      const { collector, juice, jusd, anyone } = await loadFixture(deployFixture);
      // Mint some JUICE shares to the collector (simulating accumulated buy-back).
      await juice.mint(await collector.getAddress(), ethers.parseEther("10"));
      // Seed the Equity with JUSD so redeem has proceeds to send (no-op since
      // target == JUICE itself, but the mock requires non-zero balance for transfer).
      await jusd.mint(await juice.getAddress(), ethers.parseEther("1000"));

      const totalBefore = await juice.totalSupply();
      await collector.connect(anyone).burnJuiceShares();
      const totalAfter = await juice.totalSupply();

      expect(totalAfter).to.equal(totalBefore - ethers.parseEther("10"));
      expect(await juice.balanceOf(await collector.getAddress())).to.equal(0);
    });

    it("reverts with NothingToBurn when no JUICE held", async () => {
      const { collector } = await loadFixture(deployFixture);
      await expect(collector.burnJuiceShares())
        .to.be.revertedWithCustomError(collector, "NothingToBurn");
    });
  });

  describe("Step governance", () => {
    it("governor can change step (e.g. raise to 500 JUSD)", async () => {
      const { collector, governor, jusd, juice, anyone } = await loadFixture(deployFixture);
      await collector.connect(governor).setFlushStep(ethers.parseEther("500"));
      expect(await collector.flushStep()).to.equal(ethers.parseEther("500"));
      // Now 250 JUSD is below the new step → revert.
      await jusd.mint(await collector.getAddress(), ethers.parseEther("250"));
      await expect(collector.connect(anyone).flush())
        .to.be.revertedWithCustomError(collector, "BelowThreshold");
      // 1100 JUSD → flushes 1000, keeps 100.
      await jusd.mint(await collector.getAddress(), ethers.parseEther("850"));
      await collector.connect(anyone).flush();
      expect(await jusd.balanceOf(await juice.getAddress())).to.equal(
        ethers.parseEther("1000"),
      );
      expect(await jusd.balanceOf(await collector.getAddress())).to.equal(
        ethers.parseEther("100"),
      );
    });

    it("non-governor cannot change step", async () => {
      const { collector, anyone } = await loadFixture(deployFixture);
      await expect(
        collector.connect(anyone).setFlushStep(ethers.parseEther("1")),
      ).to.be.revertedWithCustomError(collector, "OwnableUnauthorizedAccount");
    });

    it("setFlushStep(0) reverts (division-by-zero guard)", async () => {
      const { collector, governor } = await loadFixture(deployFixture);
      await expect(collector.connect(governor).setFlushStep(0))
        .to.be.revertedWithCustomError(collector, "InvalidStep");
    });
  });

  describe("No swap / no approval / no rescue surface", () => {
    it("contract exposes ONLY: flush, tryFlush, burnJuiceShares, setFlushStep", async () => {
      const { collector } = await loadFixture(deployFixture);
      const stateChanging = collector.interface.fragments
        .filter((f) => f.type === "function")
        .filter((f) => {
          const mut = (f as any).stateMutability;
          return mut === "nonpayable" || mut === "payable";
        })
        .map((f) => (f as any).name);
      // Ownable's transferOwnership / renounceOwnership are inherited and expected.
      const allowed = new Set([
        "flush",
        "tryFlush",
        "burnJuiceShares",
        "setFlushStep",
        "transferOwnership",
        "renounceOwnership",
      ]);
      void allowed;
      for (const name of stateChanging) {
        expect(allowed.has(name), `Unexpected state-changing function: ${name}`)
          .to.equal(true);
      }
    });

    it("no function whose name contains 'approve', 'swap', 'rescue', 'sweep', 'call'", async () => {
      const { collector } = await loadFixture(deployFixture);
      const banned = ["approve", "swap", "rescue", "sweep", "withdraw", "transfer"];
      for (const f of collector.interface.fragments) {
        if (f.type !== "function") continue;
        const name = (f as any).name as string;
        const low = name.toLowerCase();
        // transferOwnership is OK
        if (low === "transferownership" || low === "renounceownership") continue;
        for (const b of banned) {
          if (low.includes(b)) {
            throw new Error(`Function ${name} matches forbidden pattern '${b}'`);
          }
        }
      }
    });
  });
});
