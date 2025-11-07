// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockWETH
 * @notice Mock Wrapped Ether for testing
 */
contract MockWETH is ERC20 {
    constructor() ERC20("Mock Wrapped Ether", "WETH") {
        // 18 decimals like real WETH
        _mint(msg.sender, 1_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
