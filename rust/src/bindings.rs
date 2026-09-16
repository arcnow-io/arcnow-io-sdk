#![allow(missing_docs, clippy::too_many_arguments)]
macro_rules! b {
    ($m:ident, $n:ident, $p:literal) => {
        pub mod $m {
            alloy::sol!(
                #[sol(rpc)]
                $n,
                $p
            );
        }
    };
}
b!(launchpad, Launchpad, "src/generated/abi/Launchpad.json");
b!(quote_registry, QuoteRegistry, "src/generated/abi/QuoteRegistry.json");
b!(curve, BondingCurve, "src/generated/abi/BondingCurve.json");
b!(token, ArcToken, "src/generated/abi/ArcToken.json");
b!(platform_registry, PlatformRegistry, "src/generated/abi/PlatformRegistry.json");
b!(platform_config, PlatformConfig, "src/generated/abi/PlatformConfig.json");
b!(migrator_registry, MigratorRegistry, "src/generated/abi/MigratorRegistry.json");
b!(v4_migrator, UniswapV4Migrator, "src/generated/abi/UniswapV4Migrator.json");
b!(fee_hook, ArcNowFeeHook, "src/generated/abi/ArcNowFeeHook.json");

// NOT an arcnow.io contract, and pinned differently: `../pins.json` records the
// address this ABI was written against and the keccak256 of the code there,
// because nothing in this repository can re-derive it from a commit the way it
// can for the ABIs above. See `pins.json`'s `external` block.
b!(router, UniswapV4Router04, "src/generated/abi/external/UniswapV4Router04.json");

/// The slice of ERC-20 a quote token is read and approved through: metadata,
/// balance, allowance and `approve`. Declared by hand because a quote token is
/// not arcnow.io's contract and nothing else of it is called.
pub mod erc20 {
    alloy::sol! {
        #[sol(rpc)]
        interface IERC20Metadata {
            function name() external view returns (string);
            function symbol() external view returns (string);
            function decimals() external view returns (uint8);
            function balanceOf(address account) external view returns (uint256);
            function allowance(address owner, address spender) external view returns (uint256);
            function approve(address spender, uint256 amount) external returns (bool);
        }
    }
}

/// Multicall3's `aggregate3` and `getEthBalance`, as deployed at
/// [`crate::constants::MULTICALL3`]: the batch every heterogeneous read in
/// this crate travels in.
pub mod multicall3 {
    alloy::sol! {
        #[sol(rpc)]
        interface IMulticall3 {
            struct Call3 {
                address target;
                bool allowFailure;
                bytes callData;
            }
            struct Result {
                bool success;
                bytes returnData;
            }
            function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory returnData);
            function getEthBalance(address addr) external view returns (uint256 balance);
        }
    }
}

/// The one piece of Uniswap v4's `PoolManager` this crate reads: its `Swap`
/// event, declared by hand exactly as `IPoolManager.sol` declares it at the
/// v4-core commit arcnow-io/contracts vendors (`e50237c4`). Written out rather
/// than pinned as a whole ABI because nothing else of the manager is called.
/// `pool::tests` pins its topic against the log the live `PoolManager` emitted.
pub mod pool_manager {
    alloy::sol! {
        interface IPoolManager {
            event Swap(
                bytes32 indexed id,
                address indexed sender,
                int128 amount0,
                int128 amount1,
                uint160 sqrtPriceX96,
                uint128 liquidity,
                int24 tick,
                uint24 fee
            );
        }
    }
}
