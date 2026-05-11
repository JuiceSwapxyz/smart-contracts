// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IUniswapV3FactoryAdmin {
    function owner() external view returns (address);
    function setOwner(address _owner) external;
    function enableFeeAmount(uint24 fee, int24 tickSpacing) external;
    function feeAmountTickSpacing(uint24 fee) external view returns (int24);
}

interface IUniswapV3PoolAdmin {
    function setFeeProtocol(uint8 feeProtocol0, uint8 feeProtocol1) external;
    function collectProtocol(
        address recipient,
        uint128 amount0Requested,
        uint128 amount1Requested
    ) external returns (uint128 amount0, uint128 amount1);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/**
 * @title ProtocolFeeKeeper
 * @notice Thin owner-wrapper for the UniswapV3 Factory. Sits between the
 *         JuiceSwap Governor (DAO) and the Factory and partitions the
 *         Factory's privileged powers between two roles:
 *
 *           GOVERNOR  – the JuiceSwap DAO. May enable new fee tiers, swap
 *                       out the operator, change the default protocol-fee
 *                       ratio, and (emergency) transfer Factory ownership
 *                       to a new owner contract.
 *           OPERATOR  – a hot-key bot. May ONLY (a) activate the configured
 *                       protocol fee ratio on a list of pools and (b)
 *                       collect protocol fees from a list of pools to the
 *                       hardcoded FEE_COLLECTOR. Operator can do nothing
 *                       that moves funds anywhere else.
 *
 * @dev Security envelope:
 *      - `FEE_COLLECTOR` is immutable. Collect recipient cannot be changed
 *        by any role.
 *      - `MAX_PROTOCOL_FEE_VALUE = 4` is a constant lower bound on the
 *        protocol-fee denominator (= max 25% cut, the Uniswap V3 maximum).
 *      - Operator-compromise impact is bounded: attacker can only force
 *        already-due protocol fees to flow to the FeeCollector, which is
 *        the intended sink anyway.
 *      - Governor can replace Operator instantly; no veto/timelock at this
 *        layer (the FeeCollector itself can have one downstream).
 */
contract ProtocolFeeKeeper is ReentrancyGuard {
    // ---------------------------------------------------------------------
    // Immutable security anchors
    // ---------------------------------------------------------------------

    /// @notice UniswapV3 Factory under management.
    IUniswapV3FactoryAdmin public immutable FACTORY;

    /// @notice Hardcoded recipient of every collectProtocol() call.
    address public immutable FEE_COLLECTOR;

    /// @notice DAO / Governor address.
    address public immutable GOVERNOR;

    /**
     * @notice Uniswap V3 protocol-fee values are 0 (off) or in [4,10].
     *         The protocol receives 1/value of swap fees. value=4 == 25%
     *         is the maximum. We refuse anything outside {0} ∪ [4,10].
     */
    uint8 public constant MIN_PROTOCOL_FEE_VALUE = 4;
    uint8 public constant MAX_PROTOCOL_FEE_VALUE = 10;

    // ---------------------------------------------------------------------
    // Governable state
    // ---------------------------------------------------------------------

    /// @notice Operator bot allowed to call activate / collect.
    address public operator;

    /// @notice Default protocol-fee denominator applied by `activateProtocolFee`.
    ///         4 (= 25% cut, the maximum) by default. May be set to 0 to disable.
    uint8 public defaultFeeValue;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);
    event DefaultFeeValueUpdated(uint8 oldValue, uint8 newValue);
    event FeeAmountEnabled(uint24 indexed fee, int24 indexed tickSpacing);
    event ProtocolFeeActivated(address indexed pool, uint8 value);
    event ProtocolFeeCollected(address indexed pool, uint128 amount0, uint128 amount1);
    event FactoryOwnerTransferred(address indexed newOwner);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error InvalidAddress();
    error InvalidFeeValue();
    error Unauthorized();
    error LengthMismatch();

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyGovernor() {
        if (msg.sender != GOVERNOR) revert Unauthorized();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert Unauthorized();
        _;
    }

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    constructor(
        address _factory,
        address _feeCollector,
        address _governor,
        address _operator,
        uint8 _defaultFeeValue
    ) {
        if (_factory == address(0)) revert InvalidAddress();
        if (_feeCollector == address(0)) revert InvalidAddress();
        if (_governor == address(0)) revert InvalidAddress();
        if (_operator == address(0)) revert InvalidAddress();
        _validateFeeValue(_defaultFeeValue);

        FACTORY = IUniswapV3FactoryAdmin(_factory);
        FEE_COLLECTOR = _feeCollector;
        GOVERNOR = _governor;
        operator = _operator;
        defaultFeeValue = _defaultFeeValue;
    }

    // ---------------------------------------------------------------------
    // Governor-only
    // ---------------------------------------------------------------------

    function setOperator(address newOperator) external onlyGovernor {
        if (newOperator == address(0)) revert InvalidAddress();
        emit OperatorUpdated(operator, newOperator);
        operator = newOperator;
    }

    function setDefaultFeeValue(uint8 newValue) external onlyGovernor {
        _validateFeeValue(newValue);
        emit DefaultFeeValueUpdated(defaultFeeValue, newValue);
        defaultFeeValue = newValue;
    }

    /**
     * @notice Whitelist a new fee tier on the Factory (e.g. 2500 = 0.25%).
     * @dev    Irreversible on the Factory.
     */
    function enableFeeAmount(uint24 fee, int24 tickSpacing) external onlyGovernor {
        FACTORY.enableFeeAmount(fee, tickSpacing);
        emit FeeAmountEnabled(fee, tickSpacing);
    }

    /**
     * @notice Emergency: hand Factory ownership to a new owner contract.
     *         Use only to migrate to a new ProtocolFeeKeeper version.
     */
    function transferFactoryOwner(address newOwner) external onlyGovernor {
        if (newOwner == address(0)) revert InvalidAddress();
        FACTORY.setOwner(newOwner);
        emit FactoryOwnerTransferred(newOwner);
    }

    // ---------------------------------------------------------------------
    // Operator-only — narrowly scoped
    // ---------------------------------------------------------------------

    /**
     * @notice Activate the configured protocol-fee ratio on a batch of pools.
     * @dev    Uses the same denominator for token0 and token1. Value is
     *         the current `defaultFeeValue` — operator cannot pick its own.
     */
    function activateProtocolFee(address[] calldata pools) external onlyOperator nonReentrant {
        uint8 v = defaultFeeValue;
        uint256 n = pools.length;
        for (uint256 i; i < n; ++i) {
            address pool = pools[i];
            if (pool == address(0)) revert InvalidAddress();
            IUniswapV3PoolAdmin(pool).setFeeProtocol(v, v);
            emit ProtocolFeeActivated(pool, v);
        }
    }

    /**
     * @notice Collect protocol fees from a batch of pools. Recipient is
     *         hardcoded to FEE_COLLECTOR — operator has no choice.
     */
    function collect(address[] calldata pools) external onlyOperator nonReentrant {
        uint256 n = pools.length;
        for (uint256 i; i < n; ++i) {
            address pool = pools[i];
            if (pool == address(0)) revert InvalidAddress();
            (uint128 a0, uint128 a1) = IUniswapV3PoolAdmin(pool).collectProtocol(
                FEE_COLLECTOR,
                type(uint128).max,
                type(uint128).max
            );
            emit ProtocolFeeCollected(pool, a0, a1);
        }
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _validateFeeValue(uint8 v) internal pure {
        // 0 means "disabled"; otherwise must be in [4, 10] per UniswapV3 spec.
        if (v == 0) return;
        if (v < MIN_PROTOCOL_FEE_VALUE || v > MAX_PROTOCOL_FEE_VALUE) {
            revert InvalidFeeValue();
        }
    }
}
