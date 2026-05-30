// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title EchidnaGatewayV2FeeMath
 * @notice Property fuzzing for the JuiceSwapGatewayV2 25 bps ceil fee.
 *
 * JuiceSwapGatewayV2._protocolFee is:
 *     Math.mulDiv(amountIn, 25, 10_000, Math.Rounding.Ceil)
 *
 * For amountIn <= 1e30, amountIn * 25 cannot overflow. The property contract
 * inlines the equivalent ceil formula so Echidna can attack the arithmetic
 * without deploying gateway dependencies.
 */
contract EchidnaGatewayV2FeeMath {
    uint256 public constant PROTOCOL_FEE_BPS = 25;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 internal constant MAX_AMOUNT_IN = 10 ** 30;

    uint256 public amountIn;
    uint256 public fee;

    function _protocolFee(uint256 a) internal pure returns (uint256) {
        if (a == 0) return 0;
        return (a * PROTOCOL_FEE_BPS + (BPS_DENOMINATOR - 1)) / BPS_DENOMINATOR;
    }

    function setAmountIn(uint256 a) public {
        amountIn = a % (MAX_AMOUNT_IN + 1);
        fee = _protocolFee(amountIn);
    }

    function echidna_fee_never_exceeds_input() public view returns (bool) {
        return fee <= amountIn;
    }

    function echidna_fee_at_least_exact_share() public view returns (bool) {
        return fee * BPS_DENOMINATOR >= amountIn * PROTOCOL_FEE_BPS;
    }

    function echidna_fee_ceil_upper_bound() public view returns (bool) {
        return fee * BPS_DENOMINATOR < amountIn * PROTOCOL_FEE_BPS + BPS_DENOMINATOR;
    }

    function echidna_zero_input_zero_fee() public view returns (bool) {
        return amountIn != 0 || fee == 0;
    }

    function echidna_trade_plus_fee_conserves_input() public view returns (bool) {
        if (fee > amountIn) return false;
        uint256 tradeAmount = amountIn - fee;
        return tradeAmount + fee == amountIn;
    }
}
