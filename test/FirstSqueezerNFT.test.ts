import { expect } from "chai";
import { ethers } from "hardhat";
import { FirstSqueezerNFT } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("FirstSqueezerNFT", function () {
  let nft: FirstSqueezerNFT;
  let signer: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;

  const METADATA_URI = "ipfs://QmTest123456789";
  const CAMPAIGN_END = 1761955199; // October 31, 2025 23:59:59 UTC

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

  beforeEach(async function () {
    [, signer, user1, user2, attacker] = await ethers.getSigners();

    const FirstSqueezerNFT = await ethers.getContractFactory("FirstSqueezerNFT");
    nft = (await FirstSqueezerNFT.deploy(signer.address, METADATA_URI)) as unknown as FirstSqueezerNFT;
    await nft.waitForDeployment();
  });

  describe("Deployment", function () {
    it("Should set the correct name and symbol", async function () {
      expect(await nft.name()).to.equal("First Squeezer");
      expect(await nft.symbol()).to.equal("SQUEEZER");
    });

    it("Should set the correct signer address", async function () {
      expect(await nft.signer()).to.equal(signer.address);
    });

    it("Should set the correct campaign end timestamp", async function () {
      expect(await nft.CAMPAIGN_END()).to.equal(CAMPAIGN_END);
    });

    it("Should start with zero total supply", async function () {
      expect(await nft.totalSupply()).to.equal(0);
    });

    it("Should revert on zero address signer", async function () {
      const FirstSqueezerNFT = await ethers.getContractFactory("FirstSqueezerNFT");
      await expect(
        FirstSqueezerNFT.deploy(ethers.ZeroAddress, METADATA_URI)
      ).to.be.revertedWith("Invalid signer address");
    });
  });

  describe("Claim Functionality", function () {
    it("Should allow valid claim with correct signature", async function () {
      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);

      await expect(nft.connect(user1).claim(signature))
        .to.emit(nft, "NFTClaimed")
        .withArgs(user1.address, 1);

      expect(await nft.hasClaimed(user1.address)).to.be.true;
      expect(await nft.totalSupply()).to.equal(1);
      expect(await nft.ownerOf(1)).to.equal(user1.address);
    });

    it("Should mint token ID starting at 1", async function () {
      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);
      await nft.connect(user1).claim(signature);

      expect(await nft.ownerOf(1)).to.equal(user1.address);
      expect(await nft.totalSupply()).to.equal(1);
    });

    it("Should allow multiple users to claim", async function () {
      const sig1 = await generateSignature(await nft.getAddress(), user1.address, signer);
      const sig2 = await generateSignature(await nft.getAddress(), user2.address, signer);

      await nft.connect(user1).claim(sig1);
      await nft.connect(user2).claim(sig2);

      expect(await nft.totalSupply()).to.equal(2);
      expect(await nft.ownerOf(1)).to.equal(user1.address);
      expect(await nft.ownerOf(2)).to.equal(user2.address);
    });

    it("Should revert on double claim attempt", async function () {
      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);

      await nft.connect(user1).claim(signature);

      await expect(nft.connect(user1).claim(signature))
        .to.be.revertedWithCustomError(nft, "AlreadyClaimed");
    });

    it("Should revert with invalid signature", async function () {
      const wrongSignature = await generateSignature(await nft.getAddress(), user1.address, attacker);

      await expect(nft.connect(user1).claim(wrongSignature))
        .to.be.revertedWithCustomError(nft, "InvalidSignature");
    });

    it("Should revert when signature is for different address", async function () {
      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);

      await expect(nft.connect(user2).claim(signature))
        .to.be.revertedWithCustomError(nft, "InvalidSignature");
    });

    it("Should revert with malformed signature", async function () {
      const invalidSignature = "0x1234";

      await expect(nft.connect(user1).claim(invalidSignature))
        .to.be.reverted;
    });
  });

  describe("Token URI (Static Metadata)", function () {
    beforeEach(async function () {
      // Mint some tokens
      const sig1 = await generateSignature(await nft.getAddress(), user1.address, signer);
      const sig2 = await generateSignature(await nft.getAddress(), user2.address, signer);
      await nft.connect(user1).claim(sig1);
      await nft.connect(user2).claim(sig2);
    });

    it("Should return static metadata URI for token 1", async function () {
      expect(await nft.tokenURI(1)).to.equal(METADATA_URI);
    });

    it("Should return static metadata URI for token 2", async function () {
      expect(await nft.tokenURI(2)).to.equal(METADATA_URI);
    });

    it("Should return same URI for all tokens (not appending token ID)", async function () {
      const uri1 = await nft.tokenURI(1);
      const uri2 = await nft.tokenURI(2);

      expect(uri1).to.equal(uri2);
      expect(uri1).to.equal(METADATA_URI);
      expect(uri1).to.not.include("/1");
      expect(uri2).to.not.include("/2");
    });

    it("Should revert for non-existent token", async function () {
      await expect(nft.tokenURI(999))
        .to.be.revertedWithCustomError(nft, "ERC721NonexistentToken");
    });

    it("Should revert for token ID 0 (tokens start at 1)", async function () {
      await expect(nft.tokenURI(0))
        .to.be.revertedWithCustomError(nft, "ERC721NonexistentToken");
    });
  });

  describe("Total Supply", function () {
    it("Should start at 0", async function () {
      expect(await nft.totalSupply()).to.equal(0);
    });

    it("Should increment with each claim", async function () {
      const sig1 = await generateSignature(await nft.getAddress(), user1.address, signer);
      await nft.connect(user1).claim(sig1);
      expect(await nft.totalSupply()).to.equal(1);

      const sig2 = await generateSignature(await nft.getAddress(), user2.address, signer);
      await nft.connect(user2).claim(sig2);
      expect(await nft.totalSupply()).to.equal(2);
    });

    it("Should not increment on failed claims", async function () {
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
      expect(await nft.hasClaimed(user1.address)).to.be.false;
      expect(await nft.hasClaimed(user2.address)).to.be.false;
    });

    it("Should be true after successful claim", async function () {
      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);
      await nft.connect(user1).claim(signature);

      expect(await nft.hasClaimed(user1.address)).to.be.true;
      expect(await nft.hasClaimed(user2.address)).to.be.false;
    });

    it("Should remain false for other users", async function () {
      const sig1 = await generateSignature(await nft.getAddress(), user1.address, signer);
      await nft.connect(user1).claim(sig1);

      expect(await nft.hasClaimed(user1.address)).to.be.true;
      expect(await nft.hasClaimed(user2.address)).to.be.false;
      expect(await nft.hasClaimed(attacker.address)).to.be.false;
    });
  });

  describe("Event Emission", function () {
    it("Should emit NFTClaimed event with correct parameters", async function () {
      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);

      await expect(nft.connect(user1).claim(signature))
        .to.emit(nft, "NFTClaimed")
        .withArgs(user1.address, 1);
    });

    it("Should emit events with incrementing token IDs", async function () {
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
    beforeEach(async function () {
      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);
      await nft.connect(user1).claim(signature);
    });

    it("Should support ERC721 interface", async function () {
      // ERC721 interface ID: 0x80ac58cd
      expect(await nft.supportsInterface("0x80ac58cd")).to.be.true;
    });

    it("Should allow token transfers", async function () {
      await nft.connect(user1).transferFrom(user1.address, user2.address, 1);
      expect(await nft.ownerOf(1)).to.equal(user2.address);
    });

    it("Should allow approved transfers", async function () {
      await nft.connect(user1).approve(user2.address, 1);
      await nft.connect(user2).transferFrom(user1.address, user2.address, 1);
      expect(await nft.ownerOf(1)).to.equal(user2.address);
    });
  });

  describe("Security Tests", function () {
    it("Should prevent signature replay after transfer", async function () {
      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);
      await nft.connect(user1).claim(signature);

      await nft.connect(user1).transferFrom(user1.address, user2.address, 1);

      await expect(nft.connect(user1).claim(signature))
        .to.be.revertedWithCustomError(nft, "AlreadyClaimed");
    });

    it("Should maintain immutable signer address", async function () {
      expect(await nft.signer()).to.equal(signer.address);
    });

    it("Should maintain immutable campaign end", async function () {
      expect(await nft.CAMPAIGN_END()).to.equal(CAMPAIGN_END);
    });
  });

  describe("Campaign Deadline", function () {
    it("Should allow claims before deadline", async function () {
      await time.increaseTo(CAMPAIGN_END - 1000);

      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);
      await expect(nft.connect(user1).claim(signature))
        .to.emit(nft, "NFTClaimed");
    });

    it("Should allow claims at exact deadline", async function () {
      await time.setNextBlockTimestamp(CAMPAIGN_END);

      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);
      await expect(nft.connect(user1).claim(signature))
        .to.emit(nft, "NFTClaimed");
    });

    it("Should revert claims after deadline", async function () {
      await time.setNextBlockTimestamp(CAMPAIGN_END + 10);

      const signature = await generateSignature(await nft.getAddress(), user1.address, signer);
      await expect(nft.connect(user1).claim(signature))
        .to.be.revertedWithCustomError(nft, "CampaignEnded");
    });
  });
});
