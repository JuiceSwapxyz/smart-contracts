// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.0;

// Minimal interface derived from Uniswap V3 Core v1.0.0
// Source: https://github.com/Uniswap/v3-core/blob/e3589b192d0be27e100cd0daaf6c97204fdb1899/contracts/interfaces/IUniswapV3Pool.sol
// Commit: https://github.com/Uniswap/v3-core/commit/e3589b192d0be27e100cd0daaf6c97204fdb1899
// Note: Includes only functions needed by JuiceSwap governance (FeeCollector + OracleLibrary)

/**
 * @title IUniswapV3Pool
 * @notice Minimal interface subset for Uniswap V3 Pool functions used by FeeCollector and OracleLibrary
 */
interface IUniswapV3Pool {
    // ============ Fee Collection Functions ============

    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);

    function collectProtocol(
        address recipient,
        uint128 amount0Requested,
        uint128 amount1Requested
    ) external returns (uint128 amount0, uint128 amount1);

    // ============ Oracle Functions ============

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (
            int56[] memory tickCumulatives,
            uint160[] memory secondsPerLiquidityCumulativeX128s
        );

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    function observations(uint256 index)
        external
        view
        returns (
            uint32 blockTimestamp,
            int56 tickCumulative,
            uint160 secondsPerLiquidityCumulativeX128,
            bool initialized
        );

    function liquidity() external view returns (uint128);
}
