// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal mock UniswapV3Factory used by ProtocolFeeKeeper tests.
contract MockUniV3Factory {
    address public owner;
    mapping(uint24 => int24) public feeAmountTickSpacing;
    // (tokenA, tokenB, fee) -> pool address. Stored both orderings.
    mapping(address => mapping(address => mapping(uint24 => address))) private _pool;

    function setPool(address t0, address t1, uint24 fee, address pool) external {
        _pool[t0][t1][fee] = pool;
        _pool[t1][t0][fee] = pool;
    }

    function getPool(address a, address b, uint24 fee) external view returns (address) {
        return _pool[a][b][fee];
    }

    event OwnerChanged(address indexed prev, address indexed next);
    event FeeAmountEnabled(uint24 indexed fee, int24 indexed tickSpacing);

    constructor(address _owner) {
        owner = _owner;
    }

    function setOwner(address _owner) external {
        require(msg.sender == owner, "MockFactory: not owner");
        emit OwnerChanged(owner, _owner);
        owner = _owner;
    }

    function enableFeeAmount(uint24 fee, int24 tickSpacing) external {
        require(msg.sender == owner, "MockFactory: not owner");
        feeAmountTickSpacing[fee] = tickSpacing;
        emit FeeAmountEnabled(fee, tickSpacing);
    }
}

/// @notice Mock UniswapV3Pool used by ProtocolFeeKeeper tests AND by the
///         FeeRouter's TWAP-helper tests. Mocks slot0/observe so that
///         `OracleLibrary.consult` returns a configurable tick.
contract MockUniV3Pool {
    address public immutable factory;
    address public token0;
    address public token1;
    uint8 public lastFeeProtocol0;
    uint8 public lastFeeProtocol1;
    uint128 public mockAmount0;
    uint128 public mockAmount1;

    // --- TWAP mock state ---
    // tickAt sets the average tick the pool reports across the queried window.
    int24 public mockAvgTick;
    uint16 public mockCardinality;

    function setMockTwap(int24 avgTick, uint16 cardinality) external {
        mockAvgTick = avgTick;
        mockCardinality = cardinality;
    }

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
        )
    {
        sqrtPriceX96 = 1;
        tick = mockAvgTick;
        observationIndex = 0;
        observationCardinality = mockCardinality;
        observationCardinalityNext = mockCardinality;
        feeProtocol = 0;
        unlocked = true;
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (
            int56[] memory tickCumulatives,
            uint160[] memory secondsPerLiquidityCumulativeX128s
        )
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        // tickCumulative[i] = avgTick * (now - secondsAgos[i])
        // secondsPerLiquidity[i] increases monotonically with `now - secondsAgos[i]`
        // so the delta is non-zero (avoids OracleLibrary harmonic-mean div-by-0).
        for (uint256 i = 0; i < secondsAgos.length; ++i) {
            uint256 elapsed = uint256(block.timestamp) - uint256(secondsAgos[i]);
            int56 deltaSec = int56(int256(elapsed));
            tickCumulatives[i] = int56(mockAvgTick) * deltaSec;
            // arbitrary monotonically increasing series, value isn't used by
            // the FeeRouter's TWAP read (only `arithmeticMeanTick`).
            secondsPerLiquidityCumulativeX128s[i] = uint160(elapsed + 1);
        }
    }

    constructor(address _factory, address _t0, address _t1) {
        factory = _factory;
        token0 = _t0;
        token1 = _t1;
    }

    function _isFactoryOwner() internal view returns (bool) {
        return msg.sender == MockUniV3Factory(factory).owner();
    }

    function setMockCollectAmounts(uint128 a0, uint128 a1) external {
        mockAmount0 = a0;
        mockAmount1 = a1;
    }

    function setFeeProtocol(uint8 v0, uint8 v1) external {
        require(_isFactoryOwner(), "MockPool: not factory owner");
        lastFeeProtocol0 = v0;
        lastFeeProtocol1 = v1;
    }

    function collectProtocol(
        address recipient,
        uint128 /*req0*/,
        uint128 /*req1*/
    ) external returns (uint128 amount0, uint128 amount1) {
        require(_isFactoryOwner(), "MockPool: not factory owner");
        amount0 = mockAmount0;
        amount1 = mockAmount1;
        recipient; // silence
    }
}
