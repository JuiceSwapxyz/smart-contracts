// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title MockUniswapV3Factory
 * @notice Mock Uniswap V3 Factory for testing
 * @dev Allows manual pool address registration for testing
 */
contract MockUniswapV3Factory {
    // Mapping from (token0, token1, fee) => pool address
    mapping(address => mapping(address => mapping(uint24 => address))) private _pools;

    event PoolCreated(
        address indexed token0,
        address indexed token1,
        uint24 indexed fee,
        address pool
    );

    /**
     * @notice Register a pool address for a token pair
     * @dev Ensures tokens are correctly ordered (token0 < token1)
     */
    function registerPool(
        address tokenA,
        address tokenB,
        uint24 fee,
        address pool
    ) external {
        // Ensure correct token ordering
        (address token0, address token1) = tokenA < tokenB
            ? (tokenA, tokenB)
            : (tokenB, tokenA);

        _pools[token0][token1][fee] = pool;

        emit PoolCreated(token0, token1, fee, pool);
    }

    /**
     * @notice Get pool address for a token pair
     * @dev Handles token ordering automatically like real Uniswap V3 Factory
     */
    function getPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external view returns (address pool) {
        // Ensure correct token ordering
        (address token0, address token1) = tokenA < tokenB
            ? (tokenA, tokenB)
            : (tokenB, tokenA);

        return _pools[token0][token1][fee];
    }

    /**
     * @notice Compute pool address using CREATE2 formula
     * @dev In production, this returns the deterministic address
     * @dev In our mock, we return the registered address
     */
    function computeAddress(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external view returns (address pool) {
        // Ensure correct token ordering
        (address token0, address token1) = tokenA < tokenB
            ? (tokenA, tokenB)
            : (tokenB, tokenA);

        return _pools[token0][token1][fee];
    }
}
