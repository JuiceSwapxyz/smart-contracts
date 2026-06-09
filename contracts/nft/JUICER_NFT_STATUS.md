# JuicerNFT — status

The points-reward NFT for the Juice Points program, modeled on
[`FirstSqueezerNFT.sol`](./FirstSqueezerNFT.sol): signature-based `claim(bytes)`
verified by the backend signer, one mint per address, a campaign window and a
hard max-supply cap. Owner can rotate the signer.

## State

- **Contract:** `contracts/nft/JuicerNFT.sol` — complete.
- **Tests:** `test/JuicerNFT.test.ts` — 48 passing (`npx hardhat test test/JuicerNFT.test.ts`).
- **Deploy script:** `scripts/deployJuicerNFT.ts` — parameterized via env.
- **Deployed:** **NO.** Intentionally not deployed yet (see below).

## ⚠️ Before any deployment

1. **Artwork / metadata — must be different from the First Squeezer NFT.**
   The token image + metadata are supplied at deploy time via
   `JUICER_BASE_TOKEN_URI` (IPFS), not baked into the contract. The final
   Juicer artwork is **still a placeholder / TODO** — pin the new image +
   metadata to IPFS and set `JUICER_BASE_TOKEN_URI` to that CID before deploying.
2. The on-chain `signer` must equal the api's `JUICER_SIGNER_PRIVATE_KEY` address,
   or every `claim()` reverts with `InvalidSignature`.
3. The frontend keeps the Juicer NFT surfaces hidden behind `JUICE_POINTS_NFT`
   (bapp) until the NFT is explicitly unlocked — people collect points first.

Do **not** run `scripts/deployJuicerNFT.ts` until the artwork is finalized and a
deploy is explicitly authorized.
