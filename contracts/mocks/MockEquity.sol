// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title MockEquity
 * @notice Mock implementation of the Equity (JUICE) contract for testing
 * @dev Simulates invest() and redeem() functionality
 */
contract MockEquity is ERC20 {
    IERC20 public immutable JUSD;

    // Simple pricing: 1 JUICE = 100 JUSD (can be adjusted)
    uint256 public constant PRICE = 100e18;

    constructor(
        string memory name,
        string memory symbol,
        address jusd
    ) ERC20(name, symbol) {
        JUSD = IERC20(jusd);
    }

    /**
     * @notice Invest JUSD to receive JUICE
     * @param amount Amount of JUSD to invest
     * @param expectedShares Minimum shares expected (ignored in mock)
     * @return shares Amount of JUICE minted
     */
    function invest(uint256 amount, uint256 expectedShares) external returns (uint256 shares) {
        expectedShares; // Silence unused variable warning

        JUSD.transferFrom(msg.sender, address(this), amount);

        // Calculate shares: amount / PRICE
        shares = (amount * 1e18) / PRICE;
        _mint(msg.sender, shares);

        return shares;
    }

    /**
     * @notice Redeem JUICE for JUSD
     * @param target Address to send JUSD to
     * @param shares Amount of JUICE to redeem
     * @return proceeds Amount of JUSD returned
     */
    function redeem(address target, uint256 shares) external returns (uint256 proceeds) {
        _burn(msg.sender, shares);

        // Calculate proceeds: shares * PRICE
        proceeds = (shares * PRICE) / 1e18;
        JUSD.transfer(target, proceeds);

        return proceeds;
    }

    /**
     * @notice Calculate JUSD received when redeeming JUICE
     * @param shares Amount of JUICE to redeem
     * @return proceeds Amount of JUSD that would be received
     */
    function calculateProceeds(uint256 shares) external pure returns (uint256 proceeds) {
        return (shares * PRICE) / 1e18;
    }

    /**
     * @notice Calculate JUICE received when investing JUSD
     * @param investment Amount of JUSD to invest
     * @return shares Amount of JUICE that would be received
     */
    function calculateShares(uint256 investment) external pure returns (uint256 shares) {
        return (investment * 1e18) / PRICE;
    }

    /**
     * @notice Mint JUICE for testing
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
