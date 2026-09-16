//! Trade deadlines, as a named thing rather than a raw timestamp.
//!
//! Every state-changing trade on a curve takes a deadline, and the reason is not
//! ceremony: a transaction that sits in the mempool and is included an hour
//! later fills at an hour-later price. The deadline is the caller saying how
//! stale a fill they are willing to accept, and the curve reverts with
//! [`crate::Error::DeadlineExpired`] past it.
//!
//! A raw `u256` at the call site is how a deadline ends up being `now` (already
//! expired by the time the block is mined), or a block *number* where seconds
//! were wanted, or `0`, which is the same as `now` and expires immediately. So
//! it is a type, and the type has three constructors that each say what they
//! mean.

use core::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

use alloy::primitives::U256;

/// A unix-seconds deadline for a trade.
///
/// ```
/// use arcnow_sdk::Deadline;
///
/// let sensible = Deadline::in_minutes(5); // the default to reach for
/// let explicit = Deadline::at(1_800_000_000);
/// let never = Deadline::none(); // and read the warning on `none`
/// ```
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Deadline(U256);

impl Deadline {
    /// `minutes` from now.
    ///
    /// **Five minutes is the sensible default** and is what to reach for unless
    /// something says otherwise: long enough to survive a busy block or two,
    /// short enough that a transaction which stalls is refused rather than
    /// filled at tomorrow's price.
    ///
    /// "Now" is this machine's clock. The chain compares against
    /// `block.timestamp`, so a host clock that is minutes behind produces a
    /// deadline that is minutes tighter than it looks, and one that is minutes
    /// ahead produces one that is looser. If that matters to you, read the
    /// chain's head timestamp and use [`Deadline::at`].
    #[must_use]
    pub fn in_minutes(minutes: u64) -> Self {
        Self::in_seconds(minutes.saturating_mul(60))
    }

    /// `seconds` from now. See [`Deadline::in_minutes`] on whose clock "now" is.
    #[must_use]
    pub fn in_seconds(seconds: u64) -> Self {
        Self::at(now_unix().saturating_add(seconds))
    }

    /// An absolute unix timestamp, in seconds.
    #[must_use]
    pub fn at(unix_seconds: u64) -> Self {
        Self(U256::from(unix_seconds))
    }

    /// No deadline at all: `type(uint256).max`.
    ///
    /// **This opts out of the protection, and the protection is real.** A
    /// transaction with no deadline can be held back — by a private mempool, by
    /// a stuck nonce ahead of it, by a node that simply did not gossip it — and
    /// executed much later, at a price the signer never saw. The slippage floor
    /// still applies, so the loss is bounded by whatever tolerance was set; the
    /// deadline is what stops a *stale* trade rather than a *bad* one.
    ///
    /// Use it for a trade where late is genuinely as good as on time. Do not use
    /// it because a deadline was inconvenient.
    #[must_use]
    pub const fn none() -> Self {
        Self(U256::MAX)
    }

    /// The raw value the contracts take.
    #[must_use]
    pub const fn to_u256(self) -> U256 {
        self.0
    }

    /// True when this deadline has already passed on this machine's clock.
    ///
    /// A cheap pre-flight: a transaction sent with an expired deadline burns gas
    /// and reverts. It is not authoritative — the chain's clock decides — but it
    /// catches the common mistake of reusing a `Deadline` built minutes ago.
    #[must_use]
    pub fn is_expired(self) -> bool {
        self.0 < U256::from(now_unix())
    }
}

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

impl fmt::Display for Deadline {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.0 == U256::MAX {
            f.write_str("none")
        } else {
            write!(f, "{} (unix seconds)", self.0)
        }
    }
}

impl fmt::Debug for Deadline {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Deadline({self})")
    }
}
