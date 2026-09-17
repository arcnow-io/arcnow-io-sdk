// GENERATED from abi/PlatformConfig.json at the repository root - do not edit.
// Pinned to arcnow-io/contracts; see pins.json.

/**
 * ABI of the arcnow.io `PlatformConfig` contract.
 *
 * `as const` because viem reads the literal types out of it: without it every
 * read, write and log decode against this contract degrades to `unknown`.
 */
export const platformConfigAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "registry_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "admin_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "feeRecipient_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "creatorShareBps_",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "refShareBps_",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "defaultMigrator_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "parameters",
        "type": "tuple",
        "internalType": "struct IPlatformConfig.CurveParameters",
        "components": [
          {
            "name": "totalSupplyWad",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "curveSupplyWad",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "y0Wad",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "r0Wad",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "targetQuoteWad",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "initialPriceWad",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "nonpayable"
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
    "name": "acceptAdmin",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "admin",
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
    "name": "checkCurveParameters",
    "inputs": [
      {
        "name": "parameters",
        "type": "tuple",
        "internalType": "struct IPlatformConfig.CurveParameters",
        "components": [
          {
            "name": "totalSupplyWad",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "curveSupplyWad",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "y0Wad",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "r0Wad",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "targetQuoteWad",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "initialPriceWad",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "creatorShareBps",
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
    "name": "curveParametersFor",
    "inputs": [
      {
        "name": "quote",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "parameters",
        "type": "tuple",
        "internalType": "struct IPlatformConfig.CurveParameters",
        "components": [
          {
            "name": "totalSupplyWad",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "curveSupplyWad",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "y0Wad",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "r0Wad",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "targetQuoteWad",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "initialPriceWad",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "defaultMigrator",
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
    "name": "feeConfig",
    "inputs": [],
    "outputs": [
      {
        "name": "config",
        "type": "tuple",
        "internalType": "struct IFeeConfig.FeeConfig",
        "components": [
          {
            "name": "creatorShareBps",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "platformShareBps",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "refShareBps",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "protocolShareBps",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "platformRecipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "protocolRecipient",
            "type": "address",
            "internalType": "address"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "feeRecipient",
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
    "name": "hasCurveParameters",
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
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingAdmin",
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
    "name": "platformShareBps",
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
    "name": "refShareBps",
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
    "name": "registry",
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
    "name": "removeCurveParameters",
    "inputs": [
      {
        "name": "quote",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setCurveParameters",
    "inputs": [
      {
        "name": "quote",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "parameters",
        "type": "tuple",
        "internalType": "struct IPlatformConfig.CurveParameters",
        "components": [
          {
            "name": "totalSupplyWad",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "curveSupplyWad",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "y0Wad",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "r0Wad",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "targetQuoteWad",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "initialPriceWad",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setDefaultMigrator",
    "inputs": [
      {
        "name": "migrator",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setFeeRecipient",
    "inputs": [
      {
        "name": "feeRecipient_",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setFeeShares",
    "inputs": [
      {
        "name": "creatorShareBps_",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "refShareBps_",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "transferAdmin",
    "inputs": [
      {
        "name": "newAdmin",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "AdminTransferStarted",
    "inputs": [
      {
        "name": "platform",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "currentAdmin",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "pendingAdmin",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "AdminTransferred",
    "inputs": [
      {
        "name": "platform",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "oldAdmin",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newAdmin",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CurveParametersChanged",
    "inputs": [
      {
        "name": "platform",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "quote",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "totalSupplyWad",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "curveSupplyWad",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "y0Wad",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "r0Wad",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "targetQuoteWad",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "initialPriceWad",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CurveParametersRemoved",
    "inputs": [
      {
        "name": "platform",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "quote",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "DefaultMigratorChanged",
    "inputs": [
      {
        "name": "platform",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "oldMigrator",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newMigrator",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "FeeRecipientChanged",
    "inputs": [
      {
        "name": "platform",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "oldRecipient",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newRecipient",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "FeeSharesChanged",
    "inputs": [
      {
        "name": "platform",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "creatorShareBps",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "refShareBps",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "platformShareBps",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "CurveNotPriceable",
    "inputs": [
      {
        "name": "curveSupplyWad",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "y0Wad",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "FeeSharesExceedAllowance",
    "inputs": [
      {
        "name": "requestedBps",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "allowanceBps",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "FeeSharesNotWhole",
    "inputs": [
      {
        "name": "totalBps",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "GraduationTargetMismatch",
    "inputs": [
      {
        "name": "expectedWad",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "actualWad",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "InitialPriceMismatch",
    "inputs": [
      {
        "name": "expectedWad",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "actualWad",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "InsufficientTokenReserve",
    "inputs": [
      {
        "name": "tokenReserveWad",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "tokensOutWad",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidReserve",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidSupplies",
    "inputs": [
      {
        "name": "totalSupplyWad",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "curveSupplyWad",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "MathOverflow",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MigratorNotRegistered",
    "inputs": [
      {
        "name": "migrator",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NoCurveParameters",
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
    "name": "NotAdmin",
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
    "name": "NotPendingAdmin",
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
    "name": "PoolReserveMismatch",
    "inputs": [
      {
        "name": "heldBackWad",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "requiredWad",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ShareExceedsDenominator",
    "inputs": [
      {
        "name": "shareBps",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroFeeRecipient",
    "inputs": []
  }
] as const;
