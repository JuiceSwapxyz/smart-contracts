module.exports = {
  skipFiles: [
    "test/",
    "mocks/",
    "governance/libraries/",
    "governance/interfaces/IUniswapV3Pool.sol",
    "governance/JuiceSwapFeeCollector.sol", // V1, not part of this PR
    "governance/JuiceSwapGovernor.sol",
    "gateway/",
    "nft/",
    "compensation/",
  ],
  configureYulOptimizer: true,
};
