// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IMockJUSD is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}

/**
 * @title MockStablecoinBridge
 * @notice Mock bridge for testing bridged stablecoin conversions
 * @dev Simulates 1:1 conversion between a bridged stablecoin (e.g., USDT) and JUSD
 */
contract MockStablecoinBridge {
    using SafeERC20 for IERC20;

    IERC20 public immutable usd;
    IMockJUSD public immutable JUSD;
    uint8 private immutable usdDecimals;
    uint8 private immutable jusdDecimals;

    uint256 public immutable horizon;
    uint256 public immutable limit;
    uint256 public minted;
    bool public stopped;

    error Stopped();
    error Expired();
    error LimitExceeded();

    constructor(address _usd, address _jusd, uint256 _limit, uint256 _weeks) {
        usd = IERC20(_usd);
        JUSD = IMockJUSD(_jusd);
        usdDecimals = IERC20Metadata(_usd).decimals();
        jusdDecimals = IERC20Metadata(_jusd).decimals();
        horizon = block.timestamp + _weeks * 1 weeks;
        limit = _limit;
    }

    function mint(uint256 amount) external {
        mintTo(msg.sender, amount);
    }

    function mintTo(address target, uint256 amount) public {
        if (stopped) revert Stopped();
        if (block.timestamp > horizon) revert Expired();

        usd.safeTransferFrom(msg.sender, address(this), amount);

        uint256 jusdAmount = _convertAmount(amount, usdDecimals, jusdDecimals);
        minted += jusdAmount;
        if (minted > limit) revert LimitExceeded();

        JUSD.mint(target, jusdAmount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, msg.sender, amount);
    }

    function burnAndSend(address target, uint256 amount) external {
        _burn(msg.sender, target, amount);
    }

    function _burn(address jusdHolder, address target, uint256 amount) internal {
        uint256 usdAmount = _convertAmount(amount, jusdDecimals, usdDecimals);

        JUSD.burn(jusdHolder, amount);
        usd.safeTransfer(target, usdAmount);
        minted -= amount;
    }

    function _convertAmount(uint256 amount, uint8 fromDecimals, uint8 toDecimals) internal pure returns (uint256) {
        if (fromDecimals < toDecimals) {
            return amount * 10 ** (toDecimals - fromDecimals);
        } else if (fromDecimals > toDecimals) {
            return amount / 10 ** (fromDecimals - toDecimals);
        }
        return amount;
    }

    // Test helpers
    function setMinted(uint256 _minted) external {
        minted = _minted;
    }

    function setStopped(bool _stopped) external {
        stopped = _stopped;
    }
}
