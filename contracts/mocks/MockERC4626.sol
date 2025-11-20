// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title MockERC4626
 * @notice Mock implementation of ERC4626 vault for testing
 * @dev Simulates svJUSD behavior with a fixed 1:1 ratio (can be adjusted for testing)
 */
contract MockERC4626 is ERC4626 {
    uint256 private _totalAssets;
    uint256 private _pricePerShare = 1e18; // 1:1 initially

    constructor(
        IERC20 asset,
        string memory name,
        string memory symbol
    ) ERC4626(asset) ERC20(name, symbol) {}

    function totalAssets() public view virtual override returns (uint256) {
        return _totalAssets;
    }

    function _deposit(
        address caller,
        address receiver,
        uint256 assets,
        uint256 shares
    ) internal virtual override {
        super._deposit(caller, receiver, assets, shares);
        _totalAssets += assets;
    }

    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal virtual override {
        super._withdraw(caller, receiver, owner, assets, shares);
        _totalAssets -= assets;
    }

    // Test helper: manually set price per share to simulate interest accrual
    function setPricePerShare(uint256 newPrice) external {
        _pricePerShare = newPrice;
    }

    // Test helper: simulate interest accrual
    function accrueInterest(uint256 interestAmount) external {
        _totalAssets += interestAmount;
    }
}
