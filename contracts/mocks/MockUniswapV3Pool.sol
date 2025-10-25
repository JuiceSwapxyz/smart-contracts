// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title MockUniswapV3Pool
 * @notice Mock Uniswap V3 Pool for testing fee collection
 */
contract MockUniswapV3Pool {
    address public token0;
    address public token1;
    uint24 public fee;

    uint128 public protocolFees0;
    uint128 public protocolFees1;

    // TWAP simulation
    int56 public tickCumulative0;
    int56 public tickCumulative1;
    uint32 public observationTimestamp0;
    uint32 public observationTimestamp1;
    int24 public currentTick;

    constructor(address _token0, address _token1, uint24 _fee) {
        require(_token0 < _token1, "Token order");
        token0 = _token0;
        token1 = _token1;
        fee = _fee;

        // Initialize TWAP at tick 0 (price = 1:1)
        currentTick = 0;
        observationTimestamp0 = uint32(block.timestamp - 1800); // 30 min ago
        observationTimestamp1 = uint32(block.timestamp);
        tickCumulative0 = 0;
        tickCumulative1 = 0;
    }

    /**
     * @notice Set protocol fees available for collection
     */
    function setProtocolFees(uint128 _fees0, uint128 _fees1) external {
        protocolFees0 = _fees0;
        protocolFees1 = _fees1;
    }

    /**
     * @notice Set current tick for TWAP calculations
     */
    function setCurrentTick(int24 _tick) external {
        currentTick = _tick;

        // Update tick cumulatives
        uint32 delta = uint32(block.timestamp) - observationTimestamp1;
        tickCumulative1 += int56(currentTick) * int56(uint56(delta));
        observationTimestamp1 = uint32(block.timestamp);
    }

    /**
     * @notice Set TWAP manually for testing
     */
    function setTWAP(int24 twapTick, uint32 twapPeriod) external {
        observationTimestamp0 = uint32(block.timestamp) - twapPeriod;
        observationTimestamp1 = uint32(block.timestamp);

        // tickCumulative = tick * time
        tickCumulative0 = 0;
        tickCumulative1 = int56(twapTick) * int56(uint56(twapPeriod));
    }

    /**
     * @notice Collect protocol fees (mock implementation)
     */
    function collectProtocol(
        address recipient,
        uint128 amount0Requested,
        uint128 amount1Requested
    ) external returns (uint128 amount0, uint128 amount1) {
        amount0 = amount0Requested > protocolFees0 ? protocolFees0 : amount0Requested;
        amount1 = amount1Requested > protocolFees1 ? protocolFees1 : amount1Requested;

        protocolFees0 -= amount0;
        protocolFees1 -= amount1;

        // Transfer tokens to recipient
        if (amount0 > 0) {
            IERC20(token0).transfer(recipient, amount0);
        }
        if (amount1 > 0) {
            IERC20(token1).transfer(recipient, amount1);
        }
    }

    /**
     * @notice Observe TWAP (mock implementation)
     */
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        uint160[] memory liquidityCumulatives = new uint160[](secondsAgos.length);

        for (uint i = 0; i < secondsAgos.length; i++) {
            if (secondsAgos[i] == 0) {
                tickCumulatives[i] = tickCumulative1;
            } else {
                tickCumulatives[i] = tickCumulative0;
            }
        }

        return (tickCumulatives, liquidityCumulatives);
    }

    /**
     * @notice slot0 (for compatibility)
     */
    function slot0() external view returns (
        uint160 sqrtPriceX96,
        int24 tick,
        uint16 observationIndex,
        uint16 observationCardinality,
        uint16 observationCardinalityNext,
        uint8 feeProtocol,
        bool unlocked
    ) {
        sqrtPriceX96 = 79228162514264337593543950336; // sqrt(1) * 2^96
        tick = currentTick;
        observationIndex = 0;
        observationCardinality = 1;
        observationCardinalityNext = 1;
        feeProtocol = 0;
        unlocked = true;
    }

    /**
     * @notice Helper to fund pool with tokens for testing
     */
    function fundPool(uint256 amount0, uint256 amount1) external {
        if (amount0 > 0) {
            IERC20(token0).transferFrom(msg.sender, address(this), amount0);
        }
        if (amount1 > 0) {
            IERC20(token1).transferFrom(msg.sender, address(this), amount1);
        }
    }
}
