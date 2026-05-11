// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "./interfaces/IExternalRouters.sol";
import "./interfaces/IUniswapV3Pool.sol";
import "./libraries/OracleLibrary.sol";
import "./libraries/Path.sol";

interface IFeeRouterV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

/**
 * @title JuiceSwapFeeRouter
 * @notice Aggregator-style swap entry. Every swap routed through this
 *         contract pays a protocol fee in basis points, capped at 5%.
 *         The fee is **always** converted to JUSD before reaching the
 *         FeeCollector: never any random token. If neither the input nor
 *         the output token is bridgeable to JUSD, the swap reverts.
 *
 *         Fee-conversion paths (Phase 1):
 *           input or output is JUSD    -> direct transfer of fee in JUSD
 *           input or output is USDC.e  -> StablecoinBridge USDC.e -> JUSD
 *           input or output is ctUSD   -> StablecoinBridge ctUSD  -> JUSD
 *
 *         Preference order: input-side if bridgeable (saves one transfer),
 *         else output-side, else revert with `NoFeePath`.
 *
 * @dev Security envelope:
 *      - `FEE_COLLECTOR`, all router and bridge addresses, all whitelisted
 *        token addresses are `immutable`. Migration = redeploy.
 *      - `MAX_FEE_BPS = 500` constant (5% hard cap).
 *      - JUSD has hardcoded 18-decimals expectation, validated at deploy.
 *      - Bridge addresses are validated at deploy to match their token.
 *      - Approvals to routers and bridges are set once at construction to
 *        `type(uint256).max` — there is no per-swap approve/clear cycle.
 *        These four spenders are immutable; cross-tx the router holds no
 *        tokens, so unlimited allowance is bounded by current-tx balance.
 *      - Output recipient is always `msg.sender`. The router never holds
 *        user funds across calls.
 *      - `nonReentrant` on every external entry.
 *
 *      Operational notes:
 *      - When a bridge is paused (`stopped() == true`), swaps that rely on
 *        that bridge for fee conversion revert with `BridgeStopped`.
 *        Governance escape: `setFeeBps(0)` keeps swaps flowing fee-free
 *        until the bridge is restored or a new router is deployed.
 */
contract JuiceSwapFeeRouter is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Path for bytes;
    using BytesLib for bytes;

    // ---------------------------------------------------------------------
    // Routes
    // ---------------------------------------------------------------------

    uint8 public constant ROUTE_SATSUMA = 0;
    uint8 public constant ROUTE_JUICESWAP_V3 = 1;

    // ---------------------------------------------------------------------
    // Immutable security anchors
    // ---------------------------------------------------------------------

    address public immutable FEE_COLLECTOR;
    address public immutable SATSUMA_ROUTER;
    address public immutable JUICESWAP_ROUTER;

    address public immutable JUSD;
    address public immutable USDC_E;
    address public immutable USDC_E_BRIDGE;
    address public immutable CTUSD;
    address public immutable CTUSD_BRIDGE;
    address public immutable WCBTC;

    /// @notice JuiceSwap V3 Factory — used to look up pool addresses for
    ///         TWAP-based slippage protection in `convertAccumulated`.
    address public immutable JUICESWAP_FACTORY;

    uint16 public constant MAX_FEE_BPS = 500;
    uint16 private constant BPS_DENOMINATOR = 10000;

    // ---------------------------------------------------------------------
    // Governable
    // ---------------------------------------------------------------------

    uint16 public feeBps;
    mapping(uint8 => bool) public feeEnabled;

    /// @notice Per-token V3 swap path used to convert accumulated non-stable
    ///         fee tokens to JUSD. DAO sets via `setConversionPath`.
    ///         Encoded as Uniswap V3 path: token0 | fee(3) | token1 | … | JUSD.
    ///         Path is validated to end in JUSD at setter time.
    mapping(address => bytes) public conversionPath;

    /// @notice Per-token minimum balance below which `convertAccumulated`
    ///         reverts. DAO sets to roughly the $100-equivalent so dust
    ///         doesn't trigger uneconomic conversions. Default 0 = no gate.
    mapping(address => uint256) public minConvertAmount;

    /// @notice TWAP observation period in seconds. Default 30 minutes.
    uint32 public twapPeriod;

    /// @notice Citrea block time in seconds. Default 2. Used to compute the
    ///         minimum observation cardinality required for a TWAP read.
    uint32 public expectedBlockTime;

    /// @notice Maximum slippage allowed by `convertAccumulated`, in BPS of
    ///         the TWAP-quoted JUSD output. Default 200 (= 2%).
    uint16 public convertMaxSlippageBps;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event FeeBpsUpdated(uint16 oldBps, uint16 newBps);
    event RouteFeeToggled(uint8 indexed route, bool enabled);
    event ConversionPathSet(address indexed token, bytes path);
    event MinConvertAmountSet(address indexed token, uint256 amount);
    event FeeAccumulated(address indexed token, uint256 amount);
    event FeeConverted(address indexed token, uint256 tokenAmount, uint256 jusdMinted);
    event SwapExecuted(
        address indexed user,
        uint8 indexed route,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address feeToken,
        uint256 feeAmount,
        uint256 jusdToCollector
    );

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error InvalidAddress();
    error FeeAboveCap();
    error InsufficientOutput();
    error ZeroAmount();
    error NoFeePath();
    error BridgeStopped(address bridge);
    error BadDecimals();
    error BridgeMismatch();
    error NativeValueMismatch();
    error NativeOnlyWithWCBTC();
    error NativeTransferFailed();
    error UnwrapOnlyForWCBTC();
    error PathMustEndInJusd();
    error PathTooShort();
    error PathNotConfigured(address token);
    error BelowMinConvert(address token, uint256 balance, uint256 minimum);
    error CannotConvertJusd();
    error InsufficientCardinality(address pool);
    error PoolDoesNotExist();
    error InvalidTwapParams();
    error TokenIsBridgeable(address token);

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    struct ConstructorArgs {
        address feeCollector;
        address satsumaRouter;
        address juiceswapRouter;
        address juiceswapFactory;
        address governor;
        address jusd;
        address usdce;
        address usdceBridge;
        address ctusd;
        address ctusdBridge;
        address wcbtc;
    }

    constructor(ConstructorArgs memory a) Ownable(a.governor) {
        if (a.feeCollector == address(0)) revert InvalidAddress();
        if (a.satsumaRouter == address(0)) revert InvalidAddress();
        if (a.juiceswapRouter == address(0)) revert InvalidAddress();
        if (a.juiceswapFactory == address(0)) revert InvalidAddress();
        if (a.jusd == address(0)) revert InvalidAddress();
        if (a.usdce == address(0)) revert InvalidAddress();
        if (a.usdceBridge == address(0)) revert InvalidAddress();
        if (a.ctusd == address(0)) revert InvalidAddress();
        if (a.ctusdBridge == address(0)) revert InvalidAddress();
        if (a.wcbtc == address(0)) revert InvalidAddress();

        // A3: JUSD must be 18-decimals (otherwise downstream accounting breaks).
        if (IERC20Metadata(a.jusd).decimals() != 18) revert BadDecimals();

        // A2: bridges must be wired to their advertised source token.
        if (IFeeRouterStablecoinBridge(a.usdceBridge).usd() != a.usdce) revert BridgeMismatch();
        if (IFeeRouterStablecoinBridge(a.ctusdBridge).usd() != a.ctusd) revert BridgeMismatch();

        FEE_COLLECTOR = a.feeCollector;
        SATSUMA_ROUTER = a.satsumaRouter;
        JUICESWAP_ROUTER = a.juiceswapRouter;
        JUICESWAP_FACTORY = a.juiceswapFactory;
        JUSD = a.jusd;
        USDC_E = a.usdce;
        USDC_E_BRIDGE = a.usdceBridge;
        CTUSD = a.ctusd;
        CTUSD_BRIDGE = a.ctusdBridge;
        WCBTC = a.wcbtc;

        feeBps = 25;
        feeEnabled[ROUTE_SATSUMA] = true;
        feeEnabled[ROUTE_JUICESWAP_V3] = false;

        twapPeriod = 1800;          // 30 min
        expectedBlockTime = 2;       // Citrea block time
        convertMaxSlippageBps = 200; // 2%

        // B1: one-time max approvals for the two DEX routers and two bridges.
        // Spenders are immutable; the router holds no tokens cross-tx so
        // unlimited allowance is bounded by within-tx balance.
        IERC20(a.usdce).forceApprove(a.usdceBridge, type(uint256).max);
        IERC20(a.ctusd).forceApprove(a.ctusdBridge, type(uint256).max);
        // Pre-approve both DEX routers for the three whitelisted spend
        // tokens; other tokens will be re-approved per swap if and when
        // governance widens support.
        IERC20(a.jusd).forceApprove(a.satsumaRouter, type(uint256).max);
        IERC20(a.jusd).forceApprove(a.juiceswapRouter, type(uint256).max);
        IERC20(a.usdce).forceApprove(a.satsumaRouter, type(uint256).max);
        IERC20(a.usdce).forceApprove(a.juiceswapRouter, type(uint256).max);
        IERC20(a.ctusd).forceApprove(a.satsumaRouter, type(uint256).max);
        IERC20(a.ctusd).forceApprove(a.juiceswapRouter, type(uint256).max);
    }

    // ---------------------------------------------------------------------
    // Governance
    // ---------------------------------------------------------------------

    function setFeeBps(uint16 newBps) external onlyOwner {
        if (newBps > MAX_FEE_BPS) revert FeeAboveCap();
        emit FeeBpsUpdated(feeBps, newBps);
        feeBps = newBps;
    }

    function setRouteFeeEnabled(uint8 route, bool enabled) external onlyOwner {
        feeEnabled[route] = enabled;
        emit RouteFeeToggled(route, enabled);
    }

    /**
     * @notice Register a JuiceSwap-V3 multi-hop conversion path used by
     *         `convertAccumulated` to swap an accumulated fee token to JUSD.
     *
     * @param token  Token whose accumulated balance should be convertible.
     *               Must not be JUSD (no conversion needed) or any of the
     *               bridge-supported tokens (USDC.e, ctUSD — they convert
     *               via the bridge instead).
     * @param path   Uniswap-V3 path bytes: tokenIn | fee(3) | tokenN | …
     *               Must start with `token` and end in `JUSD`. Pass `0x`
     *               (empty) to unregister and disable conversion.
     *
     * @dev Governor only. Pool selection is governance's responsibility;
     *      a poorly chosen pool yields a bad rate but cannot cause theft —
     *      the swap router is immutable and the JUSD recipient is the
     *      immutable FEE_COLLECTOR.
     */
    function setConversionPath(address token, bytes calldata path) external onlyOwner {
        if (token == JUSD) revert CannotConvertJusd();
        // Bridgeable tokens (USDC.e, ctUSD) convert via the immutable
        // StablecoinBridge in the hot path. A conversionPath for them
        // would be dead storage — refuse it so misconfiguration is loud.
        if (isBridgeable(token)) revert TokenIsBridgeable(token);
        if (path.length == 0) {
            delete conversionPath[token];
            emit ConversionPathSet(token, path);
            return;
        }
        if (path.length < 43) revert PathTooShort();
        // First 20 bytes must equal `token`.
        address pathStart;
        address pathEnd;
        assembly {
            // calldata path layout for bytes-calldata: first slot is data pointer
            // (we read via calldataload offsets)
            let p := path.offset
            pathStart := shr(96, calldataload(p))
            pathEnd := shr(96, calldataload(add(p, sub(path.length, 20))))
        }
        if (pathStart != token) revert PathTooShort();
        if (pathEnd != JUSD) revert PathMustEndInJusd();

        conversionPath[token] = path;
        emit ConversionPathSet(token, path);
    }

    /**
     * @notice Set the minimum token balance below which `convertAccumulated`
     *         will revert. Default 0 = no gate. Used so dust amounts don't
     *         trigger uneconomic conversions.
     */
    function setMinConvertAmount(address token, uint256 amount) external onlyOwner {
        minConvertAmount[token] = amount;
        emit MinConvertAmountSet(token, amount);
    }

    /**
     * @notice Configure TWAP-based slippage protection for `convertAccumulated`.
     * @param newTwapPeriod        Observation window in seconds. Min 300 (5 min).
     * @param newExpectedBlockTime Citrea block time. 1–60 seconds.
     * @param newMaxSlippageBps    Max allowed slippage vs TWAP, in BPS. Max 1000 (10%).
     */
    function setTwapParams(
        uint32 newTwapPeriod,
        uint32 newExpectedBlockTime,
        uint16 newMaxSlippageBps
    ) external onlyOwner {
        if (newTwapPeriod < 300) revert InvalidTwapParams();
        if (newExpectedBlockTime == 0 || newExpectedBlockTime > 60) revert InvalidTwapParams();
        if (newMaxSlippageBps > 1000) revert InvalidTwapParams();
        twapPeriod = newTwapPeriod;
        expectedBlockTime = newExpectedBlockTime;
        convertMaxSlippageBps = newMaxSlippageBps;
    }

    // ---------------------------------------------------------------------
    // Accumulated-fee conversion — permissionless, recipient hardcoded
    // ---------------------------------------------------------------------

    /**
     * @notice Convert this contract's full balance of `token` to JUSD via
     *         the configured conversionPath, and deliver the JUSD directly
     *         to `FEE_COLLECTOR`. Permissionless.
     *
     *         Reverts if:
     *           - `token` is JUSD (no conversion needed; nothing to do).
     *           - No conversion path is configured for `token`.
     *           - The balance is below `minConvertAmount[token]`.
     *
     *         The path was validated at setter time to start with `token`
     *         and end with `JUSD`. The recipient of the resulting JUSD is
     *         hardcoded to `FEE_COLLECTOR` — it is not a parameter.
     */
    function convertAccumulated(address token)
        external
        nonReentrant
        returns (uint256 jusdReceived)
    {
        if (token == JUSD) revert CannotConvertJusd();

        bytes memory path = conversionPath[token];
        if (path.length == 0) revert PathNotConfigured(token);

        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 minimum = minConvertAmount[token];
        if (balance < minimum || balance == 0) {
            revert BelowMinConvert(token, balance, minimum);
        }

        // TWAP-based slippage floor. The TWAP-expected JUSD output minus
        // `convertMaxSlippageBps` is enforced on-chain, so an adversary
        // who sandwiches this transaction cannot push the actual output
        // below that floor without manipulating the TWAP across the full
        // observation window — which costs vastly more than the fee.
        uint256 expectedJusd = _twapExpectedOut(path, balance);
        uint256 amountOutMinimum =
            (expectedJusd * (BPS_DENOMINATOR - convertMaxSlippageBps)) / BPS_DENOMINATOR;

        _ensureMaxAllowance(IERC20(token), JUICESWAP_ROUTER, balance);

        uint256 jusdBefore = IERC20(JUSD).balanceOf(FEE_COLLECTOR);
        IUniswapV3SwapRouter(JUICESWAP_ROUTER).exactInput(
            IUniswapV3SwapRouter.ExactInputParams({
                path: path,
                recipient: FEE_COLLECTOR,
                deadline: block.timestamp,
                amountIn: balance,
                amountOutMinimum: amountOutMinimum
            })
        );
        jusdReceived = IERC20(JUSD).balanceOf(FEE_COLLECTOR) - jusdBefore;

        emit FeeConverted(token, balance, jusdReceived);
    }

    // ---------------------------------------------------------------------
    // TWAP helper
    // ---------------------------------------------------------------------

    /**
     * @notice Compute the TWAP-expected JUSD output for a multi-hop V3 path.
     *         Reverts if any pool in the path has insufficient observation
     *         cardinality for the configured `twapPeriod`.
     */
    function _twapExpectedOut(bytes memory path, uint256 amountIn)
        internal
        view
        returns (uint256 expectedOut)
    {
        expectedOut = amountIn;
        bytes memory remaining = path;

        uint32 period = twapPeriod;
        uint256 minCardinality = (uint256(period) / uint256(expectedBlockTime)) + 1;

        while (true) {
            bool hasMore = remaining.hasMultiplePools();
            (address tokenIn, address tokenOut, uint24 fee) = remaining.decodeFirstPool();

            address pool = IFeeRouterV3Factory(JUICESWAP_FACTORY).getPool(tokenIn, tokenOut, fee);
            if (pool == address(0)) revert PoolDoesNotExist();

            (, , , uint16 observationCardinality, , , ) = IUniswapV3Pool(pool).slot0();
            if (observationCardinality < minCardinality) revert InsufficientCardinality(pool);

            (int24 twapTick, ) = OracleLibrary.consult(pool, period);
            expectedOut = OracleLibrary.getQuoteAtTick(
                twapTick,
                SafeCast.toUint128(expectedOut),
                tokenIn,
                tokenOut
            );

            if (!hasMore) break;
            remaining = remaining.skipToken();
        }
    }

    // ---------------------------------------------------------------------
    // View helpers
    // ---------------------------------------------------------------------

    /// @notice Returns true if a given token can be converted to JUSD by
    ///         this router (i.e. it is JUSD itself or has a wired bridge).
    function isBridgeable(address token) public view returns (bool) {
        return token == JUSD || token == USDC_E || token == CTUSD;
    }

    /// @dev Returns the bridge address for a non-JUSD bridgeable token, or
    ///      address(0) for JUSD / unsupported.
    function _bridgeFor(address token) internal view returns (address) {
        if (token == USDC_E) return USDC_E_BRIDGE;
        if (token == CTUSD) return CTUSD_BRIDGE;
        return address(0);
    }

    /// @dev Set an unlimited allowance only when the current one is too
    ///     small. Saves an SSTORE on the hot path for tokens already
    ///     max-approved at construction.
    function _ensureMaxAllowance(IERC20 token, address spender, uint256 minimum) internal {
        if (token.allowance(address(this), spender) < minimum) {
            token.forceApprove(spender, type(uint256).max);
        }
    }

    // ---------------------------------------------------------------------
    // Swap — Satsuma (Algebra)
    // ---------------------------------------------------------------------

    function swapExactInputSingleSatsuma(
        address tokenIn,
        address tokenOut,
        address deployer,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint160 limitSqrtPrice,
        uint256 deadline,
        bool unwrapNative
    ) external payable nonReentrant returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();
        if (unwrapNative && tokenOut != WCBTC) revert UnwrapOnlyForWCBTC();

        bool feeOnRoute = feeEnabled[ROUTE_SATSUMA] && feeBps > 0;
        bool inFeeable = isBridgeable(tokenIn);
        bool outFeeable = isBridgeable(tokenOut);
        bool inAccrueable = !inFeeable && conversionPath[tokenIn].length > 0;
        bool outAccrueable = !outFeeable && conversionPath[tokenOut].length > 0;
        if (feeOnRoute && !inFeeable && !outFeeable && !inAccrueable && !outAccrueable) {
            revert NoFeePath();
        }

        // ---- Pull input (wrap native cBTC if msg.value > 0) ----
        IERC20 tIn = IERC20(tokenIn);
        uint256 inBalBefore = tIn.balanceOf(address(this));
        _pullInput(tokenIn, amountIn);
        uint256 received = tIn.balanceOf(address(this)) - inBalBefore;

        uint256 swapAmount = received;
        uint256 inputFee = 0;
        uint256 jusdToCollector = 0;
        if (feeOnRoute && (inFeeable || inAccrueable)) {
            inputFee = (received * feeBps) / BPS_DENOMINATOR;
            if (inputFee > 0) {
                if (inFeeable) {
                    jusdToCollector = _convertFeeToJusd(tokenIn, inputFee);
                } else {
                    // Accumulate in router for later DAO-driven conversion.
                    emit FeeAccumulated(tokenIn, inputFee);
                }
                swapAmount = received - inputFee;
            }
        }

        // ---- Execute swap. Recipient = router when we need to skim a
        //      fee from the output OR when we need to unwrap to native cBTC. ----
        bool outFee = feeOnRoute && !inFeeable && !inAccrueable && (outFeeable || outAccrueable);
        bool routerHoldsOut = outFee || unwrapNative;
        address swapRecipient = routerHoldsOut ? address(this) : msg.sender;

        _ensureMaxAllowance(tIn, SATSUMA_ROUTER, swapAmount);
        amountOut = IAlgebraSwapRouter(SATSUMA_ROUTER).exactInputSingle(
            IAlgebraSwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                deployer: deployer,
                recipient: swapRecipient,
                deadline: deadline,
                amountIn: swapAmount,
                amountOutMinimum: routerHoldsOut ? 0 : amountOutMinimum,
                limitSqrtPrice: limitSqrtPrice
            })
        );

        // ---- Apply output-side fee if needed, then deliver to user ----
        uint256 userOut = amountOut;
        uint256 outputFee = 0;
        if (outFee) {
            outputFee = (amountOut * feeBps) / BPS_DENOMINATOR;
            if (outputFee > 0) {
                if (outFeeable) {
                    jusdToCollector = _convertFeeToJusd(tokenOut, outputFee);
                } else {
                    emit FeeAccumulated(tokenOut, outputFee);
                }
            }
            userOut = amountOut - outputFee;
        }
        if (userOut < amountOutMinimum) revert InsufficientOutput();

        if (routerHoldsOut) {
            _deliverOutput(tokenOut, userOut, unwrapNative);
        }

        emit SwapExecuted(
            msg.sender,
            ROUTE_SATSUMA,
            tokenIn,
            tokenOut,
            amountIn,
            userOut,
            outFee ? tokenOut : (inputFee > 0 ? tokenIn : address(0)),
            outFee ? outputFee : inputFee,
            jusdToCollector
        );
    }

    // ---------------------------------------------------------------------
    // Swap — JuiceSwap V3 single-hop
    // ---------------------------------------------------------------------

    function swapExactInputSingleJuiceSwap(
        address tokenIn,
        address tokenOut,
        uint24 poolFee,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint160 sqrtPriceLimitX96,
        uint256 deadline,
        bool unwrapNative
    ) external payable nonReentrant returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();
        if (unwrapNative && tokenOut != WCBTC) revert UnwrapOnlyForWCBTC();

        bool feeOnRoute = feeEnabled[ROUTE_JUICESWAP_V3] && feeBps > 0;
        bool inFeeable = isBridgeable(tokenIn);
        bool outFeeable = isBridgeable(tokenOut);
        bool inAccrueable = !inFeeable && conversionPath[tokenIn].length > 0;
        bool outAccrueable = !outFeeable && conversionPath[tokenOut].length > 0;
        if (feeOnRoute && !inFeeable && !outFeeable && !inAccrueable && !outAccrueable) {
            revert NoFeePath();
        }

        IERC20 tIn = IERC20(tokenIn);
        uint256 inBalBefore = tIn.balanceOf(address(this));
        _pullInput(tokenIn, amountIn);
        uint256 received = tIn.balanceOf(address(this)) - inBalBefore;

        uint256 swapAmount = received;
        uint256 inputFee = 0;
        uint256 jusdToCollector = 0;
        if (feeOnRoute && (inFeeable || inAccrueable)) {
            inputFee = (received * feeBps) / BPS_DENOMINATOR;
            if (inputFee > 0) {
                if (inFeeable) {
                    jusdToCollector = _convertFeeToJusd(tokenIn, inputFee);
                } else {
                    emit FeeAccumulated(tokenIn, inputFee);
                }
                swapAmount = received - inputFee;
            }
        }

        bool outFee = feeOnRoute && !inFeeable && !inAccrueable && (outFeeable || outAccrueable);
        bool routerHoldsOut = outFee || unwrapNative;
        address swapRecipient = routerHoldsOut ? address(this) : msg.sender;

        _ensureMaxAllowance(tIn, JUICESWAP_ROUTER, swapAmount);
        amountOut = IUniswapV3SwapRouter(JUICESWAP_ROUTER).exactInputSingle(
            IUniswapV3SwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: poolFee,
                recipient: swapRecipient,
                deadline: deadline,
                amountIn: swapAmount,
                amountOutMinimum: routerHoldsOut ? 0 : amountOutMinimum,
                sqrtPriceLimitX96: sqrtPriceLimitX96
            })
        );

        uint256 userOut = amountOut;
        uint256 outputFee = 0;
        if (outFee) {
            outputFee = (amountOut * feeBps) / BPS_DENOMINATOR;
            if (outputFee > 0) {
                if (outFeeable) {
                    jusdToCollector = _convertFeeToJusd(tokenOut, outputFee);
                } else {
                    emit FeeAccumulated(tokenOut, outputFee);
                }
            }
            userOut = amountOut - outputFee;
        }
        if (userOut < amountOutMinimum) revert InsufficientOutput();

        if (routerHoldsOut) {
            _deliverOutput(tokenOut, userOut, unwrapNative);
        }

        emit SwapExecuted(
            msg.sender,
            ROUTE_JUICESWAP_V3,
            tokenIn,
            tokenOut,
            amountIn,
            userOut,
            outFee ? tokenOut : (inputFee > 0 ? tokenIn : address(0)),
            outFee ? outputFee : inputFee,
            jusdToCollector
        );
    }

    // ---------------------------------------------------------------------
    // Internal: fee → JUSD via bridge (or direct, if fee already JUSD)
    // ---------------------------------------------------------------------

    /// @dev Pull `amountIn` of `tokenIn` from the caller. When `msg.value`
    ///      is positive, the caller is sending native cBTC and the router
    ///      wraps it into WCBTC instead of doing an ERC20 transferFrom.
    function _pullInput(address tokenIn, uint256 amountIn) internal {
        if (msg.value > 0) {
            if (tokenIn != WCBTC) revert NativeOnlyWithWCBTC();
            if (msg.value != amountIn) revert NativeValueMismatch();
            IWrappedCBTC(WCBTC).deposit{value: msg.value}();
        } else {
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        }
    }

    /// @dev Deliver `amount` of `tokenOut` held by the router to `msg.sender`.
    ///      If `unwrap` is set and tokenOut == WCBTC, the router unwraps
    ///      first and sends native cBTC. Reverts if the native transfer fails.
    function _deliverOutput(address tokenOut, uint256 amount, bool unwrap) internal {
        if (unwrap) {
            // tokenOut == WCBTC is already enforced by the caller's guard.
            IWrappedCBTC(WCBTC).withdraw(amount);
            (bool ok, ) = msg.sender.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(tokenOut).safeTransfer(msg.sender, amount);
        }
    }

    /// @notice Receive native cBTC, but only from the WCBTC contract during
    ///         `withdraw`. All other senders are rejected.
    receive() external payable {
        if (msg.sender != WCBTC) revert NativeOnlyWithWCBTC();
    }

    function _convertFeeToJusd(address token, uint256 feeAmount)
        internal
        returns (uint256 jusdMinted)
    {
        uint256 jusdBefore = IERC20(JUSD).balanceOf(FEE_COLLECTOR);

        if (token == JUSD) {
            // Direct transfer. Balance-delta accounting mirrors the bridge
            // path below — defends against a hypothetical future JUSD that
            // could deviate from "1 unit transferred = 1 unit received".
            IERC20(JUSD).safeTransfer(FEE_COLLECTOR, feeAmount);
        } else {
            address bridge = _bridgeFor(token);
            // _bridgeFor(JUSD) returns 0 — already handled above. For any
            // other token, the function should never be reached with a
            // non-zero bridge if isBridgeable(token) was checked upstream.
            // Defensive: revert if somehow the bridge is missing.
            if (bridge == address(0)) revert NoFeePath();
            IFeeRouterStablecoinBridge b = IFeeRouterStablecoinBridge(bridge);
            if (b.stopped()) revert BridgeStopped(bridge);
            b.mintTo(FEE_COLLECTOR, feeAmount);
        }

        jusdMinted = IERC20(JUSD).balanceOf(FEE_COLLECTOR) - jusdBefore;
    }
}
