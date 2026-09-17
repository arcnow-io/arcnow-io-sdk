// GENERATED from abi/UniswapV3Migrator.json at the repository root - do not edit.
// Pinned to arcnow-io/contracts; see pins.json.

/**
 * ABI of the arcnow.io `UniswapV3Migrator` contract.
 *
 * `as const` because viem reads the literal types out of it: without it every
 * read, write and log decode against this contract degrades to `unknown`.
 */
export const uniswapV3MigratorAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "curveFactory_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "poolFactory_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "wrappedNative_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "feeTier_",
        "type": "uint24",
        "internalType": "uint24"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "receive",
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "LP_BURN_ADDRESS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_GRADUATION_PRICE_WAD",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_SQRT_RATIO",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint160",
        "internalType": "uint160"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_TICK",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "int24",
        "internalType": "int24"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MIN_SQRT_RATIO",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint160",
        "internalType": "uint160"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MIN_TICK",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "int24",
        "internalType": "int24"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "VERSION",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "string",
        "internalType": "string"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "boundaryTickFor",
    "inputs": [
      {
        "name": "tick",
        "type": "int24",
        "internalType": "int24"
      }
    ],
    "outputs": [
      {
        "name": "boundary",
        "type": "int24",
        "internalType": "int24"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "curveFactory",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "custodian",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "escrowedQuoteWad",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "amountWad",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "escrowedTokensWad",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "amountWad",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "feeTier",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint24",
        "internalType": "uint24"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "fullRangeTicks",
    "inputs": [],
    "outputs": [
      {
        "name": "lower",
        "type": "int24",
        "internalType": "int24"
      },
      {
        "name": "upper",
        "type": "int24",
        "internalType": "int24"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "graduationSqrtPriceX96",
    "inputs": [
      {
        "name": "priceWad",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "tokenIsToken0",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [
      {
        "name": "sqrtPriceX96",
        "type": "uint160",
        "internalType": "uint160"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "isMigrated",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "received",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "liquidityForAmount0",
    "inputs": [
      {
        "name": "sqrtLowerX96",
        "type": "uint160",
        "internalType": "uint160"
      },
      {
        "name": "sqrtUpperX96",
        "type": "uint160",
        "internalType": "uint160"
      },
      {
        "name": "amount0",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "liquidity",
        "type": "uint128",
        "internalType": "uint128"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "liquidityForAmount1",
    "inputs": [
      {
        "name": "sqrtLowerX96",
        "type": "uint160",
        "internalType": "uint160"
      },
      {
        "name": "sqrtUpperX96",
        "type": "uint160",
        "internalType": "uint160"
      },
      {
        "name": "amount1",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "liquidity",
        "type": "uint128",
        "internalType": "uint128"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "onGraduation",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "tokenAmountWad",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "quoteAmountWad",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "pool",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "poolFactory",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "poolFor",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "pool",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "release",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "to",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "quoteWad",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "tokenAmountWad",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "sqrtPriceX96For",
    "inputs": [
      {
        "name": "amount0",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "amount1",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "sqrtPriceX96",
        "type": "uint160",
        "internalType": "uint160"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "supportsQuote",
    "inputs": [
      {
        "name": "quote",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "taxMode",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "enum IMigrator.TaxMode"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "tickSpacing",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "int24",
        "internalType": "int24"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "uniswapV3MintCallback",
    "inputs": [
      {
        "name": "amount0Owed",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "amount1Owed",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "data",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "wrappedNative",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "EscrowReleased",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "to",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "quoteWad",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "tokenAmountWad",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "GraduationReceived",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "curve",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "quoteToken",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "quoteWad",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "tokenAmountWad",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "LiquidityBurned",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "pool",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "sqrtPriceX96",
        "type": "uint160",
        "indexed": false,
        "internalType": "uint160"
      },
      {
        "name": "boundaryTick",
        "type": "int24",
        "indexed": false,
        "internalType": "int24"
      },
      {
        "name": "upperStart",
        "type": "int24",
        "indexed": false,
        "internalType": "int24"
      },
      {
        "name": "bidLiquidity",
        "type": "uint128",
        "indexed": false,
        "internalType": "uint128"
      },
      {
        "name": "askLiquidity",
        "type": "uint128",
        "indexed": false,
        "internalType": "uint128"
      },
      {
        "name": "usdcDustWad",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "tokenDustWad",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "priceWad",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PoolRecorded",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "pool",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "mode",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum IMigrator.TaxMode"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "UniswapV3MigratorDeployed",
    "inputs": [
      {
        "name": "curveFactory",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "poolFactory",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "wrappedNative",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "feeTier",
        "type": "uint24",
        "indexed": false,
        "internalType": "uint24"
      },
      {
        "name": "tickSpacing",
        "type": "int24",
        "indexed": false,
        "internalType": "int24"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AlreadyReceived",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "FeeTierNotEnabled",
    "inputs": [
      {
        "name": "feeTier",
        "type": "uint24",
        "internalType": "uint24"
      }
    ]
  },
  {
    "type": "error",
    "name": "NoLiquidityMinted",
    "inputs": [
      {
        "name": "pool",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotACurve",
    "inputs": [
      {
        "name": "caller",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotCustodian",
    "inputs": [
      {
        "name": "caller",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NothingEscrowed",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NothingToDeposit",
    "inputs": [
      {
        "name": "usdcWad",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "tokenWad",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "PriceOutOfRange",
    "inputs": [
      {
        "name": "sqrtPriceX96",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "QuoteAmountMismatch",
    "inputs": [
      {
        "name": "expectedWad",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "receivedWad",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "QuoteNotSupported",
    "inputs": [
      {
        "name": "quote",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "TransferFailed",
    "inputs": [
      {
        "name": "to",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "amountWad",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "UnexpectedMintCallback",
    "inputs": [
      {
        "name": "caller",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "UnusableGraduationPrice",
    "inputs": [
      {
        "name": "curve",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "priceWad",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "WrappedTransferFailed",
    "inputs": [
      {
        "name": "to",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "amountWad",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  }
] as const;
