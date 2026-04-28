// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title MockRevertingPool
 * @notice Mock that reverts on setFeeProtocol, used to verify batch atomicity
 *         when a downstream pool fails mid-iteration.
 */
contract MockRevertingPool {
    error PoolReverted();

    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;

    constructor(address _token0, address _token1, uint24 _fee) {
        token0 = _token0;
        token1 = _token1;
        fee = _fee;
    }

    function setFeeProtocol(uint8, uint8) external pure {
        revert PoolReverted();
    }
}
