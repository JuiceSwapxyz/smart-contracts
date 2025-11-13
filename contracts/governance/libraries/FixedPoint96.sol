// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.0;

// Modified from Uniswap V3 Core v1.0.0
// Source: https://github.com/Uniswap/v3-core/blob/e3589b192d0be27e100cd0daaf6c97204fdb1899/contracts/libraries/FixedPoint96.sol
// Commit: https://github.com/Uniswap/v3-core/commit/e3589b192d0be27e100cd0daaf6c97204fdb1899
// Changes:
//   1. Pragma upgraded to ^0.8.0 (from >=0.4.0)
// All other code unchanged from Uniswap v1.0.0

/// @title FixedPoint96
/// @notice A library for handling binary fixed point numbers, see https://en.wikipedia.org/wiki/Q_(number_format)
/// @dev Used in SqrtPriceMath.sol
library FixedPoint96 {
    uint8 internal constant RESOLUTION = 96;
    uint256 internal constant Q96 = 0x1000000000000000000000000;
}
