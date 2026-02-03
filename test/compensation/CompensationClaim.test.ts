import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { keccak256, encodePacked } from "viem";

/**
 * Simple Merkle Tree for testing
 */
class MerkleTree {
  private leaves: `0x${string}`[];
  private layers: `0x${string}`[][];

  constructor(addresses: string[]) {
    this.leaves = addresses.map((addr) => keccak256(encodePacked(["address"], [addr.toLowerCase() as `0x${string}`])));
    this.leaves.sort((a, b) => a.localeCompare(b));
    this.layers = [this.leaves];
    this.buildTree();
  }

  private buildTree(): void {
    let currentLayer = this.leaves;
    while (currentLayer.length > 1) {
      const nextLayer: `0x${string}`[] = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        if (i + 1 < currentLayer.length) {
          const left = currentLayer[i];
          const right = currentLayer[i + 1];
          const [first, second] = left < right ? [left, right] : [right, left];
          nextLayer.push(keccak256(encodePacked(["bytes32", "bytes32"], [first, second])));
        } else {
          nextLayer.push(currentLayer[i]);
        }
      }
      this.layers.push(nextLayer);
      currentLayer = nextLayer;
    }
  }

  getRoot(): `0x${string}` {
    return this.layers[this.layers.length - 1][0];
  }

  getProof(address: string): `0x${string}`[] {
    const leaf = keccak256(encodePacked(["address"], [address.toLowerCase() as `0x${string}`]));
    let index = this.leaves.indexOf(leaf);
    if (index === -1) throw new Error(`Address ${address} not found`);

    const proof: `0x${string}`[] = [];
    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      const isRightNode = index % 2 === 1;
      const siblingIndex = isRightNode ? index - 1 : index + 1;
      if (siblingIndex < layer.length) {
        proof.push(layer[siblingIndex]);
      }
      index = Math.floor(index / 2);
    }
    return proof;
  }
}

describe("CompensationClaim", function () {
  // Test amounts
  const JUSD_AMOUNT = ethers.parseEther("10");
  const TAPFREAK_AMOUNT = ethers.parseEther("10");

  async function deployFixture() {
    const [owner, user1, user2, user3, nonEligible] = await ethers.getSigners();

    // Deploy mock ERC20 tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const jusd = await MockERC20.deploy("JUSD", "JUSD", 18);
    const tapfreak = await MockERC20.deploy("TAPFREAK", "TAPFREAK", 18);

    // Create merkle tree with eligible addresses
    const eligibleAddresses = [user1.address, user2.address, user3.address];
    const merkleTree = new MerkleTree(eligibleAddresses);
    const merkleRoot = merkleTree.getRoot();

    // Set deadline to 30 days from now
    const deadline = (await time.latest()) + 30 * 24 * 60 * 60;

    // Deploy CompensationClaim
    const CompensationClaim = await ethers.getContractFactory("CompensationClaim");
    const claim = await CompensationClaim.deploy(
      await jusd.getAddress(),
      await tapfreak.getAddress(),
      merkleRoot,
      JUSD_AMOUNT,
      TAPFREAK_AMOUNT,
      deadline
    );

    // Mint tokens to the claim contract
    const totalTokens = JUSD_AMOUNT * BigInt(eligibleAddresses.length);
    await jusd.mint(await claim.getAddress(), totalTokens);
    await tapfreak.mint(await claim.getAddress(), totalTokens);

    return {
      claim,
      jusd,
      tapfreak,
      merkleTree,
      merkleRoot,
      owner,
      user1,
      user2,
      user3,
      nonEligible,
      deadline,
    };
  }

  describe("Deployment", function () {
    it("Should set the correct token addresses", async function () {
      const { claim, jusd, tapfreak } = await loadFixture(deployFixture);
      expect(await claim.jusd()).to.equal(await jusd.getAddress());
      expect(await claim.tapfreak()).to.equal(await tapfreak.getAddress());
    });

    it("Should set the correct merkle root", async function () {
      const { claim, merkleRoot } = await loadFixture(deployFixture);
      expect(await claim.merkleRoot()).to.equal(merkleRoot);
    });

    it("Should set the correct claim amounts", async function () {
      const { claim } = await loadFixture(deployFixture);
      expect(await claim.jusdAmountPerClaim()).to.equal(JUSD_AMOUNT);
      expect(await claim.tapfreakAmountPerClaim()).to.equal(TAPFREAK_AMOUNT);
    });

    it("Should revert when JUSD address is zero", async function () {
      const [owner] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const tapfreak = await MockERC20.deploy("TAPFREAK", "TAPFREAK", 18);

      const CompensationClaim = await ethers.getContractFactory("CompensationClaim");
      await expect(
        CompensationClaim.deploy(
          ethers.ZeroAddress,
          await tapfreak.getAddress(),
          ethers.ZeroHash,
          JUSD_AMOUNT,
          TAPFREAK_AMOUNT,
          0
        )
      ).to.be.revertedWithCustomError(CompensationClaim, "ZeroAddress");
    });

    it("Should revert when TAPFREAK address is zero", async function () {
      const [owner] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const jusd = await MockERC20.deploy("JUSD", "JUSD", 18);

      const CompensationClaim = await ethers.getContractFactory("CompensationClaim");
      await expect(
        CompensationClaim.deploy(
          await jusd.getAddress(),
          ethers.ZeroAddress,
          ethers.ZeroHash,
          JUSD_AMOUNT,
          TAPFREAK_AMOUNT,
          0
        )
      ).to.be.revertedWithCustomError(CompensationClaim, "ZeroAddress");
    });
  });

  describe("Claiming", function () {
    it("Should allow eligible user to claim", async function () {
      const { claim, jusd, tapfreak, merkleTree, user1 } = await loadFixture(deployFixture);

      const proof = merkleTree.getProof(user1.address);
      const initialJusdBalance = await jusd.balanceOf(user1.address);
      const initialTapfreakBalance = await tapfreak.balanceOf(user1.address);

      await expect(claim.connect(user1).claim(proof))
        .to.emit(claim, "Claimed")
        .withArgs(user1.address, JUSD_AMOUNT, TAPFREAK_AMOUNT);

      expect(await jusd.balanceOf(user1.address)).to.equal(initialJusdBalance + JUSD_AMOUNT);
      expect(await tapfreak.balanceOf(user1.address)).to.equal(initialTapfreakBalance + TAPFREAK_AMOUNT);
      expect(await claim.hasClaimed(user1.address)).to.be.true;
      expect(await claim.totalClaims()).to.equal(1);
    });

    it("Should prevent double claiming", async function () {
      const { claim, merkleTree, user1 } = await loadFixture(deployFixture);

      const proof = merkleTree.getProof(user1.address);
      await claim.connect(user1).claim(proof);

      await expect(claim.connect(user1).claim(proof)).to.be.revertedWithCustomError(claim, "AlreadyClaimed");
    });

    it("Should reject non-eligible addresses", async function () {
      const { claim, nonEligible } = await loadFixture(deployFixture);

      // Empty proof or invalid proof
      await expect(claim.connect(nonEligible).claim([])).to.be.revertedWithCustomError(claim, "InvalidProof");
    });

    it("Should reject claims after deadline", async function () {
      const { claim, merkleTree, user1, deadline } = await loadFixture(deployFixture);

      // Move time past deadline
      await time.increaseTo(deadline + 1);

      const proof = merkleTree.getProof(user1.address);
      await expect(claim.connect(user1).claim(proof)).to.be.revertedWithCustomError(claim, "ClaimPeriodEnded");
    });

    it("Should allow multiple users to claim", async function () {
      const { claim, merkleTree, user1, user2, user3 } = await loadFixture(deployFixture);

      const proof1 = merkleTree.getProof(user1.address);
      const proof2 = merkleTree.getProof(user2.address);
      const proof3 = merkleTree.getProof(user3.address);

      await claim.connect(user1).claim(proof1);
      await claim.connect(user2).claim(proof2);
      await claim.connect(user3).claim(proof3);

      expect(await claim.totalClaims()).to.equal(3);
    });

    it("Should revert when contract has insufficient JUSD", async function () {
      const [owner, user1] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const jusd = await MockERC20.deploy("JUSD", "JUSD", 18);
      const tapfreak = await MockERC20.deploy("TAPFREAK", "TAPFREAK", 18);

      const merkleTree = new MerkleTree([user1.address]);
      const merkleRoot = merkleTree.getRoot();

      const CompensationClaim = await ethers.getContractFactory("CompensationClaim");
      const claim = await CompensationClaim.deploy(
        await jusd.getAddress(),
        await tapfreak.getAddress(),
        merkleRoot,
        JUSD_AMOUNT,
        TAPFREAK_AMOUNT,
        0
      );

      // Only fund TAPFREAK, not JUSD
      await tapfreak.mint(await claim.getAddress(), TAPFREAK_AMOUNT);

      const proof = merkleTree.getProof(user1.address);
      await expect(claim.connect(user1).claim(proof)).to.be.revertedWithCustomError(claim, "InsufficientJusdBalance");
    });

    it("Should revert when contract has insufficient TAPFREAK", async function () {
      const [owner, user1] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const jusd = await MockERC20.deploy("JUSD", "JUSD", 18);
      const tapfreak = await MockERC20.deploy("TAPFREAK", "TAPFREAK", 18);

      const merkleTree = new MerkleTree([user1.address]);
      const merkleRoot = merkleTree.getRoot();

      const CompensationClaim = await ethers.getContractFactory("CompensationClaim");
      const claim = await CompensationClaim.deploy(
        await jusd.getAddress(),
        await tapfreak.getAddress(),
        merkleRoot,
        JUSD_AMOUNT,
        TAPFREAK_AMOUNT,
        0
      );

      // Only fund JUSD, not TAPFREAK
      await jusd.mint(await claim.getAddress(), JUSD_AMOUNT);

      const proof = merkleTree.getProof(user1.address);
      await expect(claim.connect(user1).claim(proof)).to.be.revertedWithCustomError(
        claim,
        "InsufficientTapfreakBalance"
      );
    });
  });

  describe("View Functions", function () {
    it("Should correctly verify proof", async function () {
      const { claim, merkleTree, user1, nonEligible } = await loadFixture(deployFixture);

      const validProof = merkleTree.getProof(user1.address);
      expect(await claim.verifyProof(user1.address, validProof)).to.be.true;
      expect(await claim.verifyProof(nonEligible.address, [])).to.be.false;
    });

    it("Should return correct canClaim status", async function () {
      const { claim, merkleTree, user1 } = await loadFixture(deployFixture);

      const proof = merkleTree.getProof(user1.address);

      // Before claiming
      let [canClaim, reason] = await claim.canClaim(user1.address, proof);
      expect(canClaim).to.be.true;
      expect(reason).to.equal("Eligible to claim");

      // After claiming
      await claim.connect(user1).claim(proof);
      [canClaim, reason] = await claim.canClaim(user1.address, proof);
      expect(canClaim).to.be.false;
      expect(reason).to.equal("Already claimed");
    });

    it("Should return correct remaining capacity", async function () {
      const { claim, merkleTree, user1 } = await loadFixture(deployFixture);

      const initialCapacity = await claim.remainingClaimCapacity();
      expect(initialCapacity).to.equal(3); // 3 eligible addresses

      const proof = merkleTree.getProof(user1.address);
      await claim.connect(user1).claim(proof);

      const newCapacity = await claim.remainingClaimCapacity();
      expect(newCapacity).to.equal(2);
    });

    it("Should return canClaim false when deadline passed", async function () {
      const { claim, merkleTree, user1, deadline } = await loadFixture(deployFixture);

      await time.increaseTo(deadline + 1);

      const proof = merkleTree.getProof(user1.address);
      const [canClaimResult, reason] = await claim.canClaim(user1.address, proof);
      expect(canClaimResult).to.be.false;
      expect(reason).to.equal("Claim period ended");
    });

    it("Should return canClaim false when not eligible", async function () {
      const { claim, nonEligible } = await loadFixture(deployFixture);

      const [canClaimResult, reason] = await claim.canClaim(nonEligible.address, []);
      expect(canClaimResult).to.be.false;
      expect(reason).to.equal("Not eligible");
    });

    it("Should return canClaim false when insufficient JUSD", async function () {
      const [owner, user1] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const jusd = await MockERC20.deploy("JUSD", "JUSD", 18);
      const tapfreak = await MockERC20.deploy("TAPFREAK", "TAPFREAK", 18);

      const merkleTree = new MerkleTree([user1.address]);
      const merkleRoot = merkleTree.getRoot();

      const CompensationClaim = await ethers.getContractFactory("CompensationClaim");
      const claim = await CompensationClaim.deploy(
        await jusd.getAddress(),
        await tapfreak.getAddress(),
        merkleRoot,
        JUSD_AMOUNT,
        TAPFREAK_AMOUNT,
        0
      );

      // Only fund TAPFREAK
      await tapfreak.mint(await claim.getAddress(), TAPFREAK_AMOUNT);

      const proof = merkleTree.getProof(user1.address);
      const [canClaimResult, reason] = await claim.canClaim(user1.address, proof);
      expect(canClaimResult).to.be.false;
      expect(reason).to.equal("Insufficient JUSD in contract");
    });

    it("Should return canClaim false when insufficient TAPFREAK", async function () {
      const [owner, user1] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const jusd = await MockERC20.deploy("JUSD", "JUSD", 18);
      const tapfreak = await MockERC20.deploy("TAPFREAK", "TAPFREAK", 18);

      const merkleTree = new MerkleTree([user1.address]);
      const merkleRoot = merkleTree.getRoot();

      const CompensationClaim = await ethers.getContractFactory("CompensationClaim");
      const claim = await CompensationClaim.deploy(
        await jusd.getAddress(),
        await tapfreak.getAddress(),
        merkleRoot,
        JUSD_AMOUNT,
        TAPFREAK_AMOUNT,
        0
      );

      // Only fund JUSD
      await jusd.mint(await claim.getAddress(), JUSD_AMOUNT);

      const proof = merkleTree.getProof(user1.address);
      const [canClaimResult, reason] = await claim.canClaim(user1.address, proof);
      expect(canClaimResult).to.be.false;
      expect(reason).to.equal("Insufficient TAPFREAK in contract");
    });

    it("Should return correct balances from getBalances", async function () {
      const { claim, jusd, tapfreak } = await loadFixture(deployFixture);

      const [jusdBalance, tapfreakBalance] = await claim.getBalances();
      expect(jusdBalance).to.equal(await jusd.balanceOf(await claim.getAddress()));
      expect(tapfreakBalance).to.equal(await tapfreak.balanceOf(await claim.getAddress()));
    });

    it("Should return correct remaining capacity when TAPFREAK is limiting factor", async function () {
      const [owner, user1] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const jusd = await MockERC20.deploy("JUSD", "JUSD", 18);
      const tapfreak = await MockERC20.deploy("TAPFREAK", "TAPFREAK", 18);

      const merkleTree = new MerkleTree([user1.address]);

      const CompensationClaim = await ethers.getContractFactory("CompensationClaim");
      const claim = await CompensationClaim.deploy(
        await jusd.getAddress(),
        await tapfreak.getAddress(),
        merkleTree.getRoot(),
        JUSD_AMOUNT,
        TAPFREAK_AMOUNT,
        0
      );

      // Fund more JUSD than TAPFREAK - TAPFREAK should be limiting
      await jusd.mint(await claim.getAddress(), JUSD_AMOUNT * 10n);
      await tapfreak.mint(await claim.getAddress(), TAPFREAK_AMOUNT * 2n);

      const capacity = await claim.remainingClaimCapacity();
      expect(capacity).to.equal(2); // Limited by TAPFREAK
    });

    it("Should return max uint256 when claim amount is zero", async function () {
      const [owner, user1] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const jusd = await MockERC20.deploy("JUSD", "JUSD", 18);
      const tapfreak = await MockERC20.deploy("TAPFREAK", "TAPFREAK", 18);

      const merkleTree = new MerkleTree([user1.address]);

      const CompensationClaim = await ethers.getContractFactory("CompensationClaim");
      const claim = await CompensationClaim.deploy(
        await jusd.getAddress(),
        await tapfreak.getAddress(),
        merkleTree.getRoot(),
        0, // Zero JUSD amount
        TAPFREAK_AMOUNT,
        0
      );

      await tapfreak.mint(await claim.getAddress(), TAPFREAK_AMOUNT);

      const capacity = await claim.remainingClaimCapacity();
      // When jusdAmount is 0, it returns type(uint256).max, so capacity is limited by tapfreak
      expect(capacity).to.equal(1);
    });
  });

  describe("Owner Functions", function () {
    it("Should allow owner to update merkle root", async function () {
      const { claim, owner } = await loadFixture(deployFixture);

      const newRoot = ethers.keccak256(ethers.toUtf8Bytes("new root"));
      await expect(claim.connect(owner).setMerkleRoot(newRoot)).to.emit(claim, "MerkleRootUpdated");

      expect(await claim.merkleRoot()).to.equal(newRoot);
    });

    it("Should allow owner to update claim amounts", async function () {
      const { claim, owner } = await loadFixture(deployFixture);

      const newJusdAmount = ethers.parseEther("20");
      const newTapfreakAmount = ethers.parseEther("15");

      await expect(claim.connect(owner).setClaimAmounts(newJusdAmount, newTapfreakAmount))
        .to.emit(claim, "ClaimAmountsUpdated")
        .withArgs(newJusdAmount, newTapfreakAmount);

      expect(await claim.jusdAmountPerClaim()).to.equal(newJusdAmount);
      expect(await claim.tapfreakAmountPerClaim()).to.equal(newTapfreakAmount);
    });

    it("Should allow owner to update deadline", async function () {
      const { claim, owner } = await loadFixture(deployFixture);

      const newDeadline = (await time.latest()) + 60 * 24 * 60 * 60; // 60 days

      await expect(claim.connect(owner).setDeadline(newDeadline))
        .to.emit(claim, "DeadlineUpdated")
        .withArgs(newDeadline);

      expect(await claim.claimDeadline()).to.equal(newDeadline);
    });

    it("Should allow owner to remove deadline", async function () {
      const { claim, owner } = await loadFixture(deployFixture);

      await expect(claim.connect(owner).setDeadline(0)).to.emit(claim, "DeadlineUpdated").withArgs(0);

      expect(await claim.claimDeadline()).to.equal(0);
    });

    it("Should prevent withdrawal before deadline", async function () {
      const { claim, jusd, owner } = await loadFixture(deployFixture);

      await expect(
        claim.connect(owner).withdrawTokens(await jusd.getAddress(), ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(claim, "ClaimPeriodNotEnded");
    });

    it("Should allow withdrawal after deadline", async function () {
      const { claim, jusd, owner, deadline } = await loadFixture(deployFixture);

      await time.increaseTo(deadline + 1);

      const contractBalance = await jusd.balanceOf(await claim.getAddress());
      await claim.connect(owner).withdrawTokens(await jusd.getAddress(), contractBalance);

      expect(await jusd.balanceOf(await claim.getAddress())).to.equal(0);
    });

    it("Should allow emergency withdraw", async function () {
      const { claim, jusd, tapfreak, owner } = await loadFixture(deployFixture);

      await claim.connect(owner).emergencyWithdraw();

      expect(await jusd.balanceOf(await claim.getAddress())).to.equal(0);
      expect(await tapfreak.balanceOf(await claim.getAddress())).to.equal(0);
    });

    it("Should handle emergency withdraw when one token balance is zero", async function () {
      const { claim, jusd, tapfreak, owner, merkleTree, user1 } = await loadFixture(deployFixture);

      // First drain JUSD by claiming
      const proof = merkleTree.getProof(user1.address);
      await claim.connect(user1).claim(proof);

      // Manually withdraw remaining JUSD to make it zero
      const deadline = await claim.claimDeadline();
      await time.increaseTo(deadline + 1n);
      const remainingJusd = await jusd.balanceOf(await claim.getAddress());
      if (remainingJusd > 0n) {
        await claim.connect(owner).withdrawTokens(await jusd.getAddress(), remainingJusd);
      }

      // Now JUSD is 0, TAPFREAK still has balance - emergencyWithdraw should work
      expect(await jusd.balanceOf(await claim.getAddress())).to.equal(0);
      expect(await tapfreak.balanceOf(await claim.getAddress())).to.be.gt(0);

      await claim.connect(owner).emergencyWithdraw();

      expect(await tapfreak.balanceOf(await claim.getAddress())).to.equal(0);
    });

    it("Should prevent non-owner from calling owner functions", async function () {
      const { claim, user1 } = await loadFixture(deployFixture);

      await expect(claim.connect(user1).setMerkleRoot(ethers.ZeroHash)).to.be.revertedWithCustomError(
        claim,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("Security", function () {
    it("Should prevent reentrancy attacks during claim", async function () {
      const [owner, attacker] = await ethers.getSigners();

      // Deploy malicious token as JUSD
      const MaliciousERC20 = await ethers.getContractFactory("MaliciousERC20Reentrancy");
      const maliciousJusd = await MaliciousERC20.deploy();

      // Deploy normal TAPFREAK
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const tapfreak = await MockERC20.deploy("TAPFREAK", "TAPFREAK", 18);

      // Create merkle tree with attacker address
      const merkleTree = new MerkleTree([attacker.address]);
      const merkleRoot = merkleTree.getRoot();

      // Deploy CompensationClaim with malicious JUSD
      const CompensationClaim = await ethers.getContractFactory("CompensationClaim");
      const claim = await CompensationClaim.deploy(
        await maliciousJusd.getAddress(),
        await tapfreak.getAddress(),
        merkleRoot,
        JUSD_AMOUNT,
        TAPFREAK_AMOUNT,
        0
      );

      // Fund contract
      await maliciousJusd.mint(await claim.getAddress(), JUSD_AMOUNT * 2n);
      await tapfreak.mint(await claim.getAddress(), TAPFREAK_AMOUNT * 2n);

      // Setup attack - malicious token will try to call claim() again during transfer
      const proof = merkleTree.getProof(attacker.address);
      await maliciousJusd.setAttack(await claim.getAddress(), proof);

      // Execute claim - the malicious token will try reentrancy but ReentrancyGuard should block it
      await claim.connect(attacker).claim(proof);

      // Verify attacker only got tokens once (reentrancy was blocked)
      expect(await maliciousJusd.balanceOf(attacker.address)).to.equal(JUSD_AMOUNT);
      expect(await tapfreak.balanceOf(attacker.address)).to.equal(TAPFREAK_AMOUNT);

      // Verify claim was marked as completed
      expect(await claim.hasClaimed(attacker.address)).to.be.true;
      expect(await claim.totalClaims()).to.equal(1);
    });
  });
});
