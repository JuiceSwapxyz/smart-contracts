// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockFactory {
    mapping(uint24 => int24) private _feeAmountTickSpacing;

    constructor() {
        _feeAmountTickSpacing[100] = 1;
        _feeAmountTickSpacing[500] = 10;
        _feeAmountTickSpacing[3000] = 60;
        _feeAmountTickSpacing[10000] = 200;
    }

    function feeAmountTickSpacing(uint24 fee) external view returns (int24) {
        return _feeAmountTickSpacing[fee];
    }

    function enableFeeAmount(uint24 fee, int24 tickSpacing) external {
        _feeAmountTickSpacing[fee] = tickSpacing;
    }
}
