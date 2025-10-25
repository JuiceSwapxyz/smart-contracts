import { expect } from "chai";
import { ethers } from "hardhat";
import { FirstSqueezerNFT } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("FirstSqueezerNFT", function () {
  const METADATA_URI = "ipfs://QmTest123456789";

  async function generateSignature(
    contractAddress: string,
    claimer: string,
    signerWallet: HardhatEthersSigner
  ): Promise<string> {
    const chainId = 5115; // Citrea Testnet
    const messageHash = ethers.solidityPackedKeccak256(
      ["address", "uint256", "address"],
      [contractAddress, chainId, claimer]
    );
    const signature = await signerWallet.signMessage(ethers.getBytes(messageHash));
    return signature;
  }

  async function deployNFTFixture() {
    const [, signer, user1, user2, attacker] = await ethers.getSigners();

    // Use dynamic timestamps relative to current block time
    const currentTime = await time.latest();
    const CAMPAIGN_START = currentTime + 3600; // Start in 1 hour
    const CAMPAIGN_END = currentTime + 7 * 24 * 3600; // End in 7 days

    const FirstSqueezerNFT = await ethers.getContractFactory("FirstSqueezerNFT");
    const nft = (await FirstSqueezerNFT.deploy(
      signer.address,
      METADATA_URI,
      CAMPAIGN_START,
      CAMPAIGN_END
    )) as unknown as FirstSqueezerNFT;
    await nft.waitForDeployment();

    return { nft, signer, user1, user2, attacker, CAMPAIGN_START, CAMPAIGN_END };
  }

  async function deployNFTDuringCampaignFixture() {
    const fixture = await deployNFTFixture();
    await time.increaseTo(fixture.CAMPAIGN_START + 1000);
    return fixture;
  }

  describe("Deployment", function () {
    it("Should set the correct name and symbol", async function () {
      const { nft } = await loadFixture(deployNFTFixture);
      expect(await nft.name()).to.equal("First Squeezer");
      expect(await nft.symbol()).to.equal("SQUEEZER");
    });

    it("Should set the correct signer address", async function () {
      const { nft, signer } = await loadFixture(deployNFTFixture);
      expect(await nft.signer()).to.equal(signer.address);
    });

    it("Should set the correct campaign start timestamp", async function () {
      const { nft, CAMPAIGN_START } = await loadFixture(deployNFTFixture);
      expect(await nft.CAMPAIGN_START()).to.equal(CAMPAIGN_START);
    });

    it("Should set the correct campaign end timestamp", async function () {
      const { nft, CAMPAIGN_END } = await loadFixture(deployNFTFixture);
      expect(await nft.CAMPAIGN_END()).to.equal(CAMPAIGN_END);
    });

    it("Should start with zero total supply", async function () {
      const { nft } = await loadFixture(deployNFTFixture);
      expect(await nft.totalSupply()).to.equal(0);
    });

    it("Should revert on zero address signer", async function () {
      const FirstSqueezerNFT = await ethers.getContractFactory("FirstSqueezerNFT");
      const currentTime = await time.latest();
      await expect(
        FirstSqueezerNFT.deploy(
          ethers.ZeroAddress,
          METADATA_URI,
          currentTime + 3600,
          currentTime + 7 * 24 * 3600
        )
      ).to.be.revertedWith("Invalid signer address");
    });
  });

  describe("Claim Functionality", function () {
    it("Should allow valid claim with correct signature", async function () {
      const { nft, signer, user1 } = await loadFixture(deployNFTDuringCampaignFixture);
      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);

      await expect(nft.connect(user1).claim(signature))
        .to.emit(nft, "NFTClaimed")
        .withArgs(user1.address, 1);

      expect(await nft.hasClaimed(user1.address)).to.be.true;
      expect(await nft.totalSupply()).to.equal(1);
      expect(await nft.ownerOf(1)).to.equal(user1.address);
    });

    it("Should mint token ID starting at 1", async function () {
      const { nft, signer, user1 } = await loadFixture(deployNFTDuringCampaignFixture);
      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);
      await nft.connect(user1).claim(signature);

      expect(await nft.ownerOf(1)).to.equal(user1.address);
      expect(await nft.totalSupply()).to.equal(1);
    });

    it("Should allow multiple users to claim", async function () {
      const { nft, signer, user1, user2 } = await loadFixture(deployNFTDuringCampaignFixture);
      const sig1 = await generateSignature(await nft.getAddress(), user1.address, signer);
      const sig2 = await generateSignature(await nft.getAddress(), user2.address, signer);

      await nft.connect(user1).claim(sig1);
      await nft.connect(user2).claim(sig2);

      expect(await nft.totalSupply()).to.equal(2);
      expect(await nft.ownerOf(1)).to.equal(user1.address);
      expect(await nft.ownerOf(2)).to.equal(user2.address);
    });

    it("Should revert on double claim attempt", async function () {
      const { nft, signer, user1 } = await loadFixture(deployNFTDuringCampaignFixture);
      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);

      await nft.connect(user1).claim(signature);

      await expect(nft.connect(user1).claim(signature))
        .to.be.revertedWithCustomError(nft, "AlreadyClaimed");
    });

    it("Should revert with invalid signature", async function () {
      const { nft, user1, attacker } = await loadFixture(deployNFTDuringCampaignFixture);
      const wrongSignature = await generateSignature(await nft.getAddress(), user1.address, attacker);

      await expect(nft.connect(user1).claim(wrongSignature))
        .to.be.revertedWithCustomError(nft, "InvalidSignature");
    });

    it("Should revert when signature is for different address", async function () {
      const { nft, signer, user1, user2 } = await loadFixture(deployNFTDuringCampaignFixture);
      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);

      await expect(nft.connect(user2).claim(signature))
        .to.be.revertedWithCustomError(nft, "InvalidSignature");
    });

    it("Should revert with malformed signature", async function () {
      const { nft, user1 } = await loadFixture(deployNFTDuringCampaignFixture);
      const invalidSignature = "0x1234";

      await expect(nft.connect(user1).claim(invalidSignature))
        .to.be.reverted;
    });
  });

  describe("Token URI (Static Metadata)", function () {
    it("Should return static metadata URI for token 1", async function () {
      const { nft, signer, user1 } = await loadFixture(deployNFTDuringCampaignFixture);
      const sig1 = await generateSignature(await nft.getAddress(), user1.address, signer);
      await nft.connect(user1).claim(sig1);

      expect(await nft.tokenURI(1)).to.equal(METADATA_URI);
    });

    it("Should return static metadata URI for token 2", async function () {
      const { nft, signer, user1, user2 } = await loadFixture(deployNFTDuringCampaignFixture);
      const sig1 = await generateSignature(await nft.getAddress(), user1.address, signer);
      const sig2 = await generateSignature(await nft.getAddress(), user2.address, signer);
      await nft.connect(user1).claim(sig1);
      await nft.connect(user2).claim(sig2);

      expect(await nft.tokenURI(2)).to.equal(METADATA_URI);
    });

    it("Should return same URI for all tokens (not appending token ID)", async function () {
      const { nft, signer, user1, user2 } = await loadFixture(deployNFTDuringCampaignFixture);
      const sig1 = await generateSignature(await nft.getAddress(), user1.address, signer);
      const sig2 = await generateSignature(await nft.getAddress(), user2.address, signer);
      await nft.connect(user1).claim(sig1);
      await nft.connect(user2).claim(sig2);

      const uri1 = await nft.tokenURI(1);
      const uri2 = await nft.tokenURI(2);

      expect(uri1).to.equal(uri2);
      expect(uri1).to.equal(METADATA_URI);
      expect(uri1).to.not.include("/1");
      expect(uri2).to.not.include("/2");
    });

    it("Should revert for non-existent token", async function () {
      const { nft } = await loadFixture(deployNFTDuringCampaignFixture);
      await expect(nft.tokenURI(999))
        .to.be.revertedWithCustomError(nft, "ERC721NonexistentToken");
    });

    it("Should revert for token ID 0 (tokens start at 1)", async function () {
      const { nft } = await loadFixture(deployNFTDuringCampaignFixture);
      await expect(nft.tokenURI(0))
        .to.be.revertedWithCustomError(nft, "ERC721NonexistentToken");
    });
  });

  describe("Total Supply", function () {
    it("Should start at 0", async function () {
      const { nft } = await loadFixture(deployNFTDuringCampaignFixture);
      expect(await nft.totalSupply()).to.equal(0);
    });

    it("Should increment with each claim", async function () {
      const { nft, signer, user1, user2 } = await loadFixture(deployNFTDuringCampaignFixture);
      const sig1 = await generateSignature(await nft.getAddress(), user1.address, signer);
      await nft.connect(user1).claim(sig1);
      expect(await nft.totalSupply()).to.equal(1);

      const sig2 = await generateSignature(await nft.getAddress(), user2.address, signer);
      await nft.connect(user2).claim(sig2);
      expect(await nft.totalSupply()).to.equal(2);
    });

    it("Should not increment on failed claims", async function () {
      const { nft, signer, user1 } = await loadFixture(deployNFTDuringCampaignFixture);
      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);
      await nft.connect(user1).claim(signature);
      expect(await nft.totalSupply()).to.equal(1);

      // Try to claim again (should fail)
      await expect(nft.connect(user1).claim(signature))
        .to.be.revertedWithCustomError(nft, "AlreadyClaimed");

      // Total supply should not change
      expect(await nft.totalSupply()).to.equal(1);
    });
  });

  describe("HasClaimed Mapping", function () {
    it("Should start as false for all addresses", async function () {
      const { nft, user1, user2 } = await loadFixture(deployNFTDuringCampaignFixture);
      expect(await nft.hasClaimed(user1.address)).to.be.false;
      expect(await nft.hasClaimed(user2.address)).to.be.false;
    });

    it("Should be true after successful claim", async function () {
      const { nft, signer, user1, user2 } = await loadFixture(deployNFTDuringCampaignFixture);
      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);
      await nft.connect(user1).claim(signature);

      expect(await nft.hasClaimed(user1.address)).to.be.true;
      expect(await nft.hasClaimed(user2.address)).to.be.false;
    });

    it("Should remain false for other users", async function () {
      const { nft, signer, user1, user2, attacker } = await loadFixture(deployNFTDuringCampaignFixture);
      const sig1 = await generateSignature(await nft.getAddress(), user1.address, signer);
      await nft.connect(user1).claim(sig1);

      expect(await nft.hasClaimed(user1.address)).to.be.true;
      expect(await nft.hasClaimed(user2.address)).to.be.false;
      expect(await nft.hasClaimed(attacker.address)).to.be.false;
    });
  });

  describe("Event Emission", function () {
    it("Should emit NFTClaimed event with correct parameters", async function () {
      const { nft, signer, user1 } = await loadFixture(deployNFTDuringCampaignFixture);
      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);

      await expect(nft.connect(user1).claim(signature))
        .to.emit(nft, "NFTClaimed")
        .withArgs(user1.address, 1);
    });

    it("Should emit events with incrementing token IDs", async function () {
      const { nft, signer, user1, user2 } = await loadFixture(deployNFTDuringCampaignFixture);
      const sig1 = await generateSignature(await nft.getAddress(), user1.address, signer);
      const sig2 = await generateSignature(await nft.getAddress(), user2.address, signer);

      await expect(nft.connect(user1).claim(sig1))
        .to.emit(nft, "NFTClaimed")
        .withArgs(user1.address, 1);

      await expect(nft.connect(user2).claim(sig2))
        .to.emit(nft, "NFTClaimed")
        .withArgs(user2.address, 2);
    });
  });

  describe("ERC721 Compliance", function () {
    it("Should support ERC721 interface", async function () {
      const { nft, signer, user1 } = await loadFixture(deployNFTDuringCampaignFixture);
      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);
      await nft.connect(user1).claim(signature);

      // ERC721 interface ID: 0x80ac58cd
      expect(await nft.supportsInterface("0x80ac58cd")).to.be.true;
    });

    it("Should allow token transfers", async function () {
      const { nft, signer, user1, user2 } = await loadFixture(deployNFTDuringCampaignFixture);
      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);
      await nft.connect(user1).claim(signature);

      await nft.connect(user1).transferFrom(user1.address, user2.address, 1);
      expect(await nft.ownerOf(1)).to.equal(user2.address);
    });

    it("Should allow approved transfers", async function () {
      const { nft, signer, user1, user2 } = await loadFixture(deployNFTDuringCampaignFixture);
      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);
      await nft.connect(user1).claim(signature);

      await nft.connect(user1).approve(user2.address, 1);
      await nft.connect(user2).transferFrom(user1.address, user2.address, 1);
      expect(await nft.ownerOf(1)).to.equal(user2.address);
    });
  });

  describe("Security Tests", function () {
    it("Should prevent signature replay after transfer", async function () {
      const { nft, signer, user1, user2 } = await loadFixture(deployNFTDuringCampaignFixture);
      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);
      await nft.connect(user1).claim(signature);

      await nft.connect(user1).transferFrom(user1.address, user2.address, 1);

      await expect(nft.connect(user1).claim(signature))
        .to.be.revertedWithCustomError(nft, "AlreadyClaimed");
    });

    it("Should maintain immutable signer address", async function () {
      const { nft, signer } = await loadFixture(deployNFTDuringCampaignFixture);
      expect(await nft.signer()).to.equal(signer.address);
    });

    it("Should maintain immutable campaign start", async function () {
      const { nft, CAMPAIGN_START } = await loadFixture(deployNFTDuringCampaignFixture);
      expect(await nft.CAMPAIGN_START()).to.equal(CAMPAIGN_START);
    });

    it("Should maintain immutable campaign end", async function () {
      const { nft, CAMPAIGN_END } = await loadFixture(deployNFTDuringCampaignFixture);
      expect(await nft.CAMPAIGN_END()).to.equal(CAMPAIGN_END);
    });
  });

  describe("Campaign Timeframe", function () {
    it("Should revert claims before campaign start", async function () {
      const { nft, signer, user1, CAMPAIGN_START } = await loadFixture(deployNFTFixture);
      await time.increaseTo(CAMPAIGN_START - 10);

      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);
      await expect(nft.connect(user1).claim(signature))
        .to.be.revertedWithCustomError(nft, "CampaignNotStarted");
    });

    it("Should allow claims at exact campaign start", async function () {
      const { nft, signer, user1, CAMPAIGN_START } = await loadFixture(deployNFTFixture);
      await time.increaseTo(CAMPAIGN_START);

      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);
      await expect(nft.connect(user1).claim(signature))
        .to.emit(nft, "NFTClaimed")
        .withArgs(user1.address, 1);
    });

    it("Should allow claims during campaign window", async function () {
      const { nft, signer, user1, CAMPAIGN_START, CAMPAIGN_END } = await loadFixture(deployNFTFixture);
      const midCampaign = CAMPAIGN_START + Math.floor((CAMPAIGN_END - CAMPAIGN_START) / 2);
      await time.increaseTo(midCampaign);

      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);
      await expect(nft.connect(user1).claim(signature))
        .to.emit(nft, "NFTClaimed");
    });

    it("Should allow claims before deadline", async function () {
      const { nft, signer, user1, CAMPAIGN_END } = await loadFixture(deployNFTFixture);
      await time.increaseTo(CAMPAIGN_END - 1000);

      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);
      await expect(nft.connect(user1).claim(signature))
        .to.emit(nft, "NFTClaimed");
    });

    it("Should allow claims at exact deadline", async function () {
      const { nft, signer, user1, CAMPAIGN_END } = await loadFixture(deployNFTFixture);
      // Use setNextBlockTimestamp to ensure exact timing
      await time.setNextBlockTimestamp(CAMPAIGN_END);

      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);
      await expect(nft.connect(user1).claim(signature))
        .to.emit(nft, "NFTClaimed");
    });

    it("Should revert claims after deadline", async function () {
      const { nft, signer, user1, CAMPAIGN_END } = await loadFixture(deployNFTFixture);
      await time.increaseTo(CAMPAIGN_END + 10);

      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);
      await expect(nft.connect(user1).claim(signature))
        .to.be.revertedWithCustomError(nft, "CampaignEnded");
    });
  });
});
