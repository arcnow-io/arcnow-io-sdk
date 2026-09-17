// GENERATED from abi/CurveFactory.json at the repository root - do not edit.
// Pinned to arcnow-io/contracts; see pins.json.

/**
 * ABI of the arcnow.io `CurveFactory` contract.
 *
 * `as const` because viem reads the literal types out of it: without it every
 * read, write and log decode against this contract degrades to `unknown`.
 */
export const curveFactoryAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "launchpad_",
        "type": "address",
        "internalType": "address"
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
    "name": "createCurve",
    "inputs": [
      {
        "name": "salt",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "params",
        "type": "tuple",
        "internalType": "struct ICurveFactory.CurveParams",
        "components": [
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "creator",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "migrator",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "poolTaxMode",
            "type": "uint8",
            "internalType": "enum IMigrator.TaxMode"
          },
          {
            "name": "canonicalRouter",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "quoteToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "quoteDecimals",
            "type": "uint8",
            "internalType": "uint8"
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
            "name": "curveSupplyWad",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "tradeFeeBps",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "feeConfig",
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
                "name": "devShareBps",
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
        ]
      }
    ],
    "outputs": [
      {
        "name": "curve",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "isDeployed",
    "inputs": [
      {
        "name": "curve",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "deployed",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "launchpad",
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
    "name": "predictCurveAddress",
    "inputs": [
      {
        "name": "salt",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "params",
        "type": "tuple",
        "internalType": "struct ICurveFactory.CurveParams",
        "components": [
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "creator",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "migrator",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "poolTaxMode",
            "type": "uint8",
            "internalType": "enum IMigrator.TaxMode"
          },
          {
            "name": "canonicalRouter",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "quoteToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "quoteDecimals",
            "type": "uint8",
            "internalType": "uint8"
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
            "name": "curveSupplyWad",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "tradeFeeBps",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "feeConfig",
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
                "name": "devShareBps",
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
        ]
      }
    ],
    "outputs": [
      {
        "name": "curve",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "CurveCreated",
    "inputs": [
      {
        "name": "curve",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "creator",
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
        "name": "quoteDecimals",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
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
        "name": "curveSupplyWad",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "tradeFeeBps",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "migrator",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "feeConfig",
        "type": "tuple",
        "indexed": false,
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
            "name": "devShareBps",
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
    "anonymous": false
  },
  {
    "type": "error",
    "name": "InvalidCurveParameters",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidFeeConfig",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotLaunchpad",
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
    "name": "SaltAlreadyUsed",
    "inputs": [
      {
        "name": "salt",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "existing",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  }
] as const;
