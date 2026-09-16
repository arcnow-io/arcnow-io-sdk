//! The launched token: an ordinary ERC-20, plus what makes it an `ArcToken`.
//!
//! # It taxes nothing
//!
//! `ArcToken` charges nothing on a transfer, to any address, ever. Fee-on-transfer
//! was removed in full, and for a concrete reason: Uniswap states plainly that
//! fee-on-transfer tokens "will not function with our router contracts", and v3
//! rejects them outright on its input balance-delta check. A taxing token is not
//! listable on the venues this platform migrates to, and a launchpad whose tokens
//! cannot be listed has no product. The only fee after graduation is the v4
//! hook's, taken in USDC inside the swap.
//!
//! # Two ways tokens move, and they are not the same thing
//!
//! 1. **The curve's privileged path.** `curveTransferFrom` is callable only by
//!    the token's own curve and **reads no allowance at all**. This is what makes
//!    a sell one transaction with no approve step. It is checked against
//!    `msg.sender` on every call; it is not an allowance and cannot be granted to
//!    anybody.
//! 2. **Ordinary ERC-20.** [`Token::approve`], [`Token::allowance`] and
//!    [`Token::transfer_from`] work exactly as they do on any other token, for
//!    routers and other spenders.
//!
//! The two must not be confused. An allowance can be spent by whoever holds it;
//! the curve's privilege cannot be held by anyone.
//!
//! # The canonical router
//!
//! After migration, [`Token::allowance`] answers `u256::MAX` for the venue's
//! canonical router, over every holder. That address is recorded once, at
//! migrator registration, by the protocol admin — not by the creator, not by the
//! platform, not by the migrator, and not at migration time, because by then the
//! curve exists and its holders have bought in. `address(0)` — a venue with no
//! router, which includes Uniswap v4, whose `PoolManager` settles from balances a
//! router already transferred in — is the ordinary case and grants nothing.
//!
//! **On every arcnow.io token it is `address(0)`, and for any token already
//! launched it always will be**: the value is snapshotted onto the curve at
//! launch and handed to the token at migration, and nothing can change it
//! afterwards. So a seller trading a graduated token through
//! `UniswapV4Router04` has **no standing allowance to fall back on** and must
//! call [`Token::approve`] — or [`crate::Pool::approve_router`], which is the
//! same call with the address filled in.

use alloy::primitives::{Address, B256, U256};
use alloy::providers::DynProvider;

use crate::amount::Tokens;
use crate::bindings::token::ArcToken as Abi;
use crate::client::Client;
use crate::error::Error;

/// One launched token.
#[derive(Debug, Clone, Copy)]
pub struct Token<'a> {
    client: &'a Client,
    address: Address,
}

impl<'a> Token<'a> {
    pub(crate) fn new(client: &'a Client, address: Address) -> Self {
        Self { client, address }
    }

    /// The token's address.
    #[must_use]
    pub fn address(&self) -> Address {
        self.address
    }

    fn contract(&self) -> Abi::ArcTokenInstance<DynProvider> {
        Abi::new(self.address, self.client.provider().clone())
    }

    /// The token's name.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn name(&self) -> Result<String, Error> {
        self.contract()
            .name()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a token's name"))
    }

    /// The token's ticker symbol.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn symbol(&self) -> Result<String, Error> {
        self.contract()
            .symbol()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a token's symbol"))
    }

    /// The token's decimals. **Always 18**, on every arcnow.io token.
    ///
    /// Read it anyway if you are rendering somebody else's token; hard-coding 18
    /// for an arbitrary ERC-20 is the other half of the decimals problem this SDK
    /// exists to avoid.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn decimals(&self) -> Result<u8, Error> {
        self.contract()
            .decimals()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a token's decimals"))
    }

    /// The URI of the off-chain metadata document.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn metadata_uri(&self) -> Result<String, Error> {
        self.contract()
            .metadataURI()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a token's metadata URI"))
    }

    /// The fixed supply, minted once at launch. Nothing can mint more.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn total_supply(&self) -> Result<Tokens, Error> {
        let raw = self
            .contract()
            .totalSupply()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a token's total supply"))?;
        Ok(Tokens::from_wad(raw))
    }

    /// An account's balance.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn balance_of(&self, account: Address) -> Result<Tokens, Error> {
        let raw = self
            .contract()
            .balanceOf(account)
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a token balance"))?;
        Ok(Tokens::from_wad(raw))
    }

    /// The creator seat: who receives the creator share of every fee.
    ///
    /// **Transferable by its holder**, in two steps, so a creator whose address
    /// is blocklisted on Arc has somewhere to go without the curve needing an
    /// admin. The seat carries no privilege over the curve or the token beyond
    /// the fee share: no mint, no pause, no fee switch, no upgrade.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn creator(&self) -> Result<Address, Error> {
        self.contract()
            .creator()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a token's creator"))
    }

    /// The bonding curve this token is bound to, for life.
    ///
    /// The only address that may move or burn a holder's balance through the
    /// privileged path — which is safe precisely because the curve has no owner,
    /// no admin, no pause and no upgrade path, so nobody can direct it.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn curve(&self) -> Result<Address, Error> {
        self.contract()
            .curve()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a token's curve"))
    }

    /// The canonical pool recorded at migration, or the zero address before it.
    ///
    /// Zero *after* migration too when the migrator created no market — an
    /// escrow migration — in which case nothing is taxed anywhere.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn migrated_pool(&self) -> Result<Address, Error> {
        self.contract()
            .migratedPool()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a token's migrated pool"))
    }

    /// The venue's canonical router, or the zero address if it has none.
    ///
    /// This is the address [`Token::allowance`] answers `u256::MAX` for over
    /// every holder, once the token has migrated. A recorded zero means **nobody
    /// is auto-approved**, never "the zero address is auto-approved", and it is
    /// the correct record for an escrow and for Uniswap v4.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn canonical_router(&self) -> Result<Address, Error> {
        self.contract()
            .canonicalRouter()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a token's canonical router"))
    }

    /// An ordinary ERC-20 allowance.
    ///
    /// **Not the path a sell takes.** Selling to the curve reads no allowance at
    /// all, and this number is neither required for it nor consumed by it. What
    /// this answers is what a *router or another spender* may move.
    ///
    /// After migration it answers `u256::MAX` for the venue's canonical router,
    /// over every holder, without anyone having called `approve`.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn allowance(&self, owner: Address, spender: Address) -> Result<U256, Error> {
        self.contract()
            .allowance(owner, spender)
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading an allowance"))
    }

    /// Approve `spender` to move `amount` of the signer's tokens.
    ///
    /// **You do not need this to sell to a curve.** If you reached for it because
    /// you are about to call [`crate::Curve::sell`], you do not need it: the
    /// curve's path reads no allowance, an allowance granted to the curve is not
    /// spent by a sell, and a holder who has approved nobody can always exit.
    ///
    /// You *do* need it to sell a **graduated** token, whose only venue is a
    /// Uniswap v4 pool reached through a router that pulls the token leg with
    /// `transferFrom`. [`crate::Pool::approve_router`] is this call with the
    /// right address in it, and [`crate::Pool::sell`] refuses without it.
    ///
    /// # Errors
    ///
    /// [`Error::SignerRequired`] on a read-only client;
    /// [`Error::ApproveToZeroAddress`] for a zero spender.
    pub async fn approve(&self, spender: Address, amount: U256) -> Result<B256, Error> {
        let from = self.client.require_signer("Token::approve")?;
        let pending = self
            .contract()
            .approve(spender, amount)
            .from(from)
            .send()
            .await
            .map_err(|err| Error::from_contract(err, "approving a spender"))?;
        let receipt = pending
            .get_receipt()
            .await
            .map_err(|err| Error::rpc("waiting for the approval receipt", err))?;
        if !receipt.status() {
            return Err(Error::TransactionReverted { tx_hash: receipt.transaction_hash });
        }
        Ok(receipt.transaction_hash)
    }

    /// Transfer tokens from the signer to `to`.
    ///
    /// # Errors
    ///
    /// [`Error::SignerRequired`]; [`Error::InsufficientBalance`];
    /// [`Error::TransferToZeroAddress`].
    pub async fn transfer(&self, to: Address, amount: Tokens) -> Result<B256, Error> {
        let from = self.client.require_signer("Token::transfer")?;
        let pending = self
            .contract()
            .transfer(to, amount.to_wad())
            .from(from)
            .send()
            .await
            .map_err(|err| Error::from_contract(err, "transferring tokens"))?;
        let receipt = pending
            .get_receipt()
            .await
            .map_err(|err| Error::rpc("waiting for the transfer receipt", err))?;
        if !receipt.status() {
            return Err(Error::TransactionReverted { tx_hash: receipt.transaction_hash });
        }
        Ok(receipt.transaction_hash)
    }

    /// Move `amount` from `from` to `to`, spending the signer's allowance.
    ///
    /// The ordinary ERC-20 path. The curve does not use it and cannot.
    ///
    /// # Errors
    ///
    /// [`Error::SignerRequired`]; [`Error::InsufficientAllowance`];
    /// [`Error::InsufficientBalance`].
    pub async fn transfer_from(
        &self,
        from: Address,
        to: Address,
        amount: Tokens,
    ) -> Result<B256, Error> {
        let sender = self.client.require_signer("Token::transfer_from")?;
        let pending = self
            .contract()
            .transferFrom(from, to, amount.to_wad())
            .from(sender)
            .send()
            .await
            .map_err(|err| Error::from_contract(err, "transferring tokens on an allowance"))?;
        let receipt = pending
            .get_receipt()
            .await
            .map_err(|err| Error::rpc("waiting for the transferFrom receipt", err))?;
        if !receipt.status() {
            return Err(Error::TransactionReverted { tx_hash: receipt.transaction_hash });
        }
        Ok(receipt.transaction_hash)
    }
}
