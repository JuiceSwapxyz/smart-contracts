// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockFactory {
    mapping(uint24 => int24) private _feeAmountTickSpacing;
    mapping(bytes32 => address) private _pools;

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

    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address) {
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return _pools[keccak256(abi.encodePacked(t0, t1, fee))];
    }

    function setPool(address tokenA, address tokenB, uint24 fee, address pool) external {
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        _pools[keccak256(abi.encodePacked(t0, t1, fee))] = pool;
    }
}
