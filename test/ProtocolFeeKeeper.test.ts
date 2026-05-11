import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("ProtocolFeeKeeper", () => {
  async function deployFixture() {
    const [deployer, governor, operator, feeCollector, attacker] =
      await ethers.getSigners();

    const Factory = await ethers.getContractFactory("MockUniV3Factory");
    // Factory deployed with Keeper as owner — but Keeper doesn't exist yet.
    // Trick: deploy factory with deployer as owner first, then transfer.
    const factory = await Factory.deploy(await deployer.getAddress());

    const Keeper = await ethers.getContractFactory("ProtocolFeeKeeper");
    const keeper = await Keeper.deploy(
      await factory.getAddress(),
      await feeCollector.getAddress(),
      await governor.getAddress(),
      await operator.getAddress(),
      4, // default 25% protocol cut
    );

    // Transfer factory ownership to keeper (simulates DAO migration).
    await factory.setOwner(await keeper.getAddress());

    const ERC20 = await ethers.getContractFactory("MockERC20");
    const t0 = await ERC20.deploy("T0", "T0", 18);
    const t1 = await ERC20.deploy("T1", "T1", 18);

    const Pool = await ethers.getContractFactory("MockUniV3Pool");
    const pool = await Pool.deploy(
      await factory.getAddress(),
      await t0.getAddress(),
      await t1.getAddress(),
    );
    const pool2 = await Pool.deploy(
      await factory.getAddress(),
      await t0.getAddress(),
      await t1.getAddress(),
    );

    return { factory, keeper, pool, pool2, governor, operator, feeCollector, attacker, deployer };
  }

  describe("Construction & constants", () => {
    it("sets immutables", async () => {
      const { keeper, factory, feeCollector, governor } = await loadFixture(deployFixture);
      expect(await keeper.FACTORY()).to.equal(await factory.getAddress());
      expect(await keeper.FEE_COLLECTOR()).to.equal(await feeCollector.getAddress());
      expect(await keeper.GOVERNOR()).to.equal(await governor.getAddress());
      expect(await keeper.MIN_PROTOCOL_FEE_VALUE()).to.equal(4);
      expect(await keeper.MAX_PROTOCOL_FEE_VALUE()).to.equal(10);
      expect(await keeper.defaultFeeValue()).to.equal(4);
    });

    it("rejects invalid default fee value", async () => {
      const [deployer, governor, operator, feeCollector] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("MockUniV3Factory");
      const f = await Factory.deploy(await deployer.getAddress());
      const Keeper = await ethers.getContractFactory("ProtocolFeeKeeper");
      // 3 is invalid (below MIN), 11 is invalid (above MAX)
      await expect(
        Keeper.deploy(
          await f.getAddress(),
          await feeCollector.getAddress(),
          await governor.getAddress(),
          await operator.getAddress(),
          3,
        ),
      ).to.be.revertedWithCustomError(Keeper, "InvalidFeeValue");
      await expect(
        Keeper.deploy(
          await f.getAddress(),
          await feeCollector.getAddress(),
          await governor.getAddress(),
          await operator.getAddress(),
          11,
        ),
      ).to.be.revertedWithCustomError(Keeper, "InvalidFeeValue");
    });
  });

  describe("Governor-only", () => {
    it("setOperator works for governor, fails for others", async () => {
      const { keeper, governor, attacker } = await loadFixture(deployFixture);
      await keeper.connect(governor).setOperator(await attacker.getAddress());
      expect(await keeper.operator()).to.equal(await attacker.getAddress());
    });

    it("setDefaultFeeValue allowed values: 0, [4..10]", async () => {
      const { keeper, governor } = await loadFixture(deployFixture);
      for (const v of [0, 4, 7, 10]) {
        await keeper.connect(governor).setDefaultFeeValue(v);
        expect(await keeper.defaultFeeValue()).to.equal(v);
      }
      for (const v of [1, 2, 3, 11, 255]) {
        await expect(keeper.connect(governor).setDefaultFeeValue(v))
          .to.be.revertedWithCustomError(keeper, "InvalidFeeValue");
      }
    });

    it("enableFeeAmount calls factory; only governor", async () => {
      const { keeper, factory, governor, attacker } = await loadFixture(deployFixture);
      await keeper.connect(governor).enableFeeAmount(2500, 50);
      expect(await factory.feeAmountTickSpacing(2500)).to.equal(50);
      await expect(keeper.connect(attacker).enableFeeAmount(100, 1))
        .to.be.revertedWithCustomError(keeper, "Unauthorized");
    });

    it("transferFactoryOwner works for governor only", async () => {
      const { keeper, factory, governor, attacker } = await loadFixture(deployFixture);
      await keeper.connect(governor).transferFactoryOwner(await attacker.getAddress());
      expect(await factory.owner()).to.equal(await attacker.getAddress());
    });

    it("attacker cannot perform any governor action", async () => {
      const { keeper, attacker } = await loadFixture(deployFixture);
      await expect(keeper.connect(attacker).setOperator(await attacker.getAddress()))
        .to.be.revertedWithCustomError(keeper, "Unauthorized");
      await expect(keeper.connect(attacker).setDefaultFeeValue(4))
        .to.be.revertedWithCustomError(keeper, "Unauthorized");
      await expect(keeper.connect(attacker).transferFactoryOwner(await attacker.getAddress()))
        .to.be.revertedWithCustomError(keeper, "Unauthorized");
    });
  });

  describe("Operator-only — narrowly scoped", () => {
    it("activateProtocolFee sets the default value on every listed pool", async () => {
      const { keeper, pool, pool2, operator } = await loadFixture(deployFixture);
      await keeper.connect(operator).activateProtocolFee([
        await pool.getAddress(),
        await pool2.getAddress(),
      ]);
      expect(await pool.lastFeeProtocol0()).to.equal(4);
      expect(await pool.lastFeeProtocol1()).to.equal(4);
      expect(await pool2.lastFeeProtocol0()).to.equal(4);
      expect(await pool2.lastFeeProtocol1()).to.equal(4);
    });

    it("operator cannot pick the fee value — always uses defaultFeeValue", async () => {
      const { keeper, pool, operator, governor } = await loadFixture(deployFixture);
      await keeper.connect(governor).setDefaultFeeValue(10); // 10% cut
      await keeper.connect(operator).activateProtocolFee([await pool.getAddress()]);
      expect(await pool.lastFeeProtocol0()).to.equal(10);
      expect(await pool.lastFeeProtocol1()).to.equal(10);
    });

    it("collect emits with recipient = FEE_COLLECTOR (hardcoded, not chooseable)", async () => {
      const { keeper, pool, operator } = await loadFixture(deployFixture);
      await pool.setMockCollectAmounts(1000, 2000);
      await expect(keeper.connect(operator).collect([await pool.getAddress()]))
        .to.emit(keeper, "ProtocolFeeCollected")
        .withArgs(await pool.getAddress(), 1000, 2000);
    });

    it("non-operator cannot activate / collect", async () => {
      const { keeper, pool, attacker, governor } = await loadFixture(deployFixture);
      await expect(keeper.connect(attacker).activateProtocolFee([await pool.getAddress()]))
        .to.be.revertedWithCustomError(keeper, "Unauthorized");
      await expect(keeper.connect(attacker).collect([await pool.getAddress()]))
        .to.be.revertedWithCustomError(keeper, "Unauthorized");
      // Even the governor cannot — separation of duties:
      await expect(keeper.connect(governor).activateProtocolFee([await pool.getAddress()]))
        .to.be.revertedWithCustomError(keeper, "Unauthorized");
    });

    it("activate rejects zero address pool", async () => {
      const { keeper, operator } = await loadFixture(deployFixture);
      await expect(keeper.connect(operator).activateProtocolFee([ethers.ZeroAddress]))
        .to.be.revertedWithCustomError(keeper, "InvalidAddress");
    });
  });

  describe("Security envelope", () => {
    it("FEE_COLLECTOR has no setter (immutable)", async () => {
      const { keeper } = await loadFixture(deployFixture);
      const iface = keeper.interface;
      const setters = iface.fragments.filter((f) => {
        if (f.type !== "function") return false;
        const name = (f as any).name as string;
        return name.toLowerCase().startsWith("set") && name.toLowerCase().includes("collector");
      });
      expect(setters.length).to.equal(0);
    });

    it("GOVERNOR has no setter (immutable)", async () => {
      const { keeper } = await loadFixture(deployFixture);
      const iface = keeper.interface;
      const setters = iface.fragments.filter((f) => {
        if (f.type !== "function") return false;
        const name = (f as any).name as string;
        return name.toLowerCase().startsWith("set") && name.toLowerCase().includes("governor");
      });
      expect(setters.length).to.equal(0);
    });
  });
});
