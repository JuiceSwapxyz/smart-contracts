// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IStablecoinBridge
 * @notice Interface for the StablecoinBridge contract that enables 1:1 conversion
 *         between a trusted stablecoin (e.g., USDT) and JUSD.
 */
interface IStablecoinBridge {
    /**
     * @notice Mint JUSD by depositing source stablecoin (e.g., USDT)
     * @param amount The amount of source stablecoin to convert
     */
    function mint(uint256 amount) external;

    /**
     * @notice Mint JUSD to a specific address
     * @param target The address to receive JUSD
     * @param amount The amount of source stablecoin to convert
     */
    function mintTo(address target, uint256 amount) external;

    /**
     * @notice Burn JUSD and receive source stablecoin
     * @param amount The amount of JUSD to burn
     */
    function burn(uint256 amount) external;

    /**
     * @notice Burn JUSD and send source stablecoin to a specific address
     * @param target The address to receive the source stablecoin
     * @param amount The amount of JUSD to burn
     */
    function burnAndSend(address target, uint256 amount) external;

    /**
     * @notice The expiration timestamp after which minting is disabled
     */
    function horizon() external view returns (uint256);

    /**
     * @notice The maximum amount of JUSD that can be minted through this bridge
     */
    function limit() external view returns (uint256);

    /**
     * @notice The current amount of JUSD minted through this bridge
     */
    function minted() external view returns (uint256);

    /**
     * @notice The source stablecoin token (e.g., USDT)
     */
    function usd() external view returns (address);

    /**
     * @notice The JUSD token
     */
    function JUSD() external view returns (address);
}
