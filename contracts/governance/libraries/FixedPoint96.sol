// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.0;

/// @title FixedPoint96
/// @notice A library for handling binary fixed point numbers, see https://en.wikipedia.org/wiki/Q_(number_format)
/// @dev Used in SqrtPriceMath.sol
/// @dev Adapted from Uniswap V3 FixedPoint96 for Solidity 0.8.x
///
/// DEVIATIONS FROM AUDITED SOURCE:
/// - Source: Uniswap/v3-core/contracts/libraries/FixedPoint96.sol
/// - Pragma upgraded from ">=0.4.0" to "^0.8.0"
library FixedPoint96 {
    uint8 internal constant RESOLUTION = 96;
    uint256 internal constant Q96 = 0x1000000000000000000000000;
}
