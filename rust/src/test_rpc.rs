//! A JSON-RPC endpoint in memory, for the tests that have to prove what this
//! crate does and does NOT send.
//!
//! "Refused before any RPC", "one Multicall3", "no approve when the allowance
//! already covers it" and "an exact approve otherwise" are claims about the
//! requests on the wire, so the only honest test of them records the requests.
//! A fork can show a trade settled; it cannot show that a refusal cost nothing.
//!
//! Every `eth_call` is dispatched by `(to, selector)` to a handler the test
//! registers, including each call inside a Multicall3 `aggregate3`, which is
//! decoded and answered call by call. Anything unregistered is a JSON-RPC
//! error naming what was asked, so a test can never pass on an answer it did
//! not choose.

#![allow(clippy::missing_panics_doc, clippy::unwrap_used)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll};

use alloy::primitives::{Address, B256, Bytes, U256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::rpc::client::RpcClient;
use alloy::rpc::json_rpc::{
    ErrorPayload, RequestPacket, Response, ResponsePacket, ResponsePayload, SerializedRequest,
};
use alloy::sol_types::SolCall;
use alloy::transports::{TransportError, TransportErrorKind, TransportFut};
use serde_json::{Value, json};

use crate::bindings::multicall3::IMulticall3;
use crate::client::Client;
use crate::constants::MULTICALL3;
use crate::network::NetworkConfig;

/// What a registered call answers.
#[derive(Clone, Debug)]
pub(crate) enum Answer {
    /// Return data.
    Return(Vec<u8>),
    /// A revert, with its data.
    Revert(Vec<u8>),
    /// No answer from the contract at all: the endpoint fails the request.
    TransportFailure,
}

type Handler = Arc<dyn Fn(&[u8]) -> Answer + Send + Sync>;
type LogsFor = Arc<dyn Fn(&Value) -> Vec<alloy::rpc::types::Log> + Send + Sync>;

#[derive(Default)]
struct State {
    requests: Vec<(String, Value)>,
    handlers: HashMap<(Address, [u8; 4]), Handler>,
    sent: Vec<Value>,
    receipt_logs: Option<LogsFor>,
}

/// The endpoint. Clone it freely: every clone records into the same log.
#[derive(Clone, Default)]
pub(crate) struct MockRpc {
    state: Arc<Mutex<State>>,
}

impl MockRpc {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Answer `selector` on `to` with `answer(calldata)`. Registering again
    /// replaces the previous handler.
    pub(crate) fn on<C: SolCall>(
        &self,
        to: Address,
        answer: impl Fn(C) -> Answer + Send + Sync + 'static,
    ) {
        let handler: Handler = Arc::new(move |calldata: &[u8]| {
            answer(C::abi_decode(calldata).expect("the SDK encoded a call its own ABI decodes"))
        });
        self.lock().handlers.insert((to, C::SELECTOR), handler);
    }

    /// Answer `C` on `to` with a fixed return value.
    pub(crate) fn returns<C: SolCall>(&self, to: Address, value: C::Return)
    where
        C::Return: Clone + Send + Sync + 'static,
    {
        self.on::<C>(to, move |_| Answer::Return(C::abi_encode_returns(&value)));
    }

    /// The logs every mined receipt carries, derived from the sent transaction.
    pub(crate) fn receipt_logs(
        &self,
        logs: impl Fn(&Value) -> Vec<alloy::rpc::types::Log> + Send + Sync + 'static,
    ) {
        self.lock().receipt_logs = Some(Arc::new(logs));
    }

    /// Every request, in order: `(method, params)`.
    pub(crate) fn requests(&self) -> Vec<(String, Value)> {
        self.lock().requests.clone()
    }

    /// How many requests used `method`.
    pub(crate) fn count(&self, method: &str) -> usize {
        self.lock().requests.iter().filter(|(m, _)| m == method).count()
    }

    /// Every `eth_sendTransaction` transaction object, in order.
    pub(crate) fn sent(&self) -> Vec<Value> {
        self.lock().sent.clone()
    }

    /// A client on this endpoint. No fillers: a sent transaction is recorded
    /// exactly as the SDK built it.
    pub(crate) fn client(&self, config: NetworkConfig, sender: Option<Address>) -> Client {
        let provider = ProviderBuilder::new()
            .disable_recommended_fillers()
            .connect_client(RpcClient::new(self.clone(), true))
            .erased();
        Client::from_parts(provider, config, sender)
    }

    fn handle(&self, request: &SerializedRequest) -> ResponsePayload {
        let params: Value = request
            .params()
            .map_or(Value::Null, |raw| serde_json::from_str(raw.get()).unwrap_or(Value::Null));
        let method = request.method().to_owned();
        self.lock().requests.push((method.clone(), params.clone()));
        match method.as_str() {
            "eth_call" => self.eth_call(&params),
            "eth_sendTransaction" => {
                let tx = params[0].clone();
                let mut state = self.lock();
                state.sent.push(tx);
                let hash = B256::with_last_byte(u8::try_from(state.sent.len()).unwrap());
                success(&json!(hash))
            }
            "eth_getTransactionReceipt" => {
                let hash: B256 = serde_json::from_value(params[0].clone()).unwrap();
                let index = usize::from(hash[31]);
                let (tx, logs) = {
                    let state = self.lock();
                    let Some(tx) = state.sent.get(index.wrapping_sub(1)).cloned() else {
                        return success(&Value::Null);
                    };
                    let logs = state.receipt_logs.as_ref().map(|f| f(&tx)).unwrap_or_default();
                    (tx, logs)
                };
                success(&receipt(hash, &tx, &logs))
            }
            "eth_estimateGas" => self.estimate_gas(&params),
            "eth_blockNumber" => success(&json!("0x1")),
            "eth_chainId" => success(&json!("0x4cef52")),
            other => failure(-32601, &format!("the mock endpoint does not answer {other}")),
        }
    }

    fn eth_call(&self, params: &Value) -> ResponsePayload {
        let to: Address = serde_json::from_value(params[0]["to"].clone()).unwrap();
        let input = calldata(&params[0]);
        if to == MULTICALL3 && input[..4] == IMulticall3::aggregate3Call::SELECTOR {
            let calls = IMulticall3::aggregate3Call::abi_decode(&input).unwrap().calls;
            let mut results = Vec::with_capacity(calls.len());
            for call in calls {
                match self.answer(call.target, &call.callData) {
                    Answer::Return(data) => {
                        results
                            .push(IMulticall3::Result { success: true, returnData: data.into() });
                    }
                    Answer::Revert(data) => results
                        .push(IMulticall3::Result { success: false, returnData: data.into() }),
                    Answer::TransportFailure => return failure(-32005, "rate limit exceeded"),
                }
            }
            let encoded = IMulticall3::aggregate3Call::abi_encode_returns(&results);
            return success(&json!(Bytes::from(encoded)));
        }
        match self.answer(to, &input) {
            Answer::Return(data) => success(&json!(Bytes::from(data))),
            Answer::Revert(data) => ResponsePayload::Failure(ErrorPayload {
                code: 3,
                message: "execution reverted".into(),
                data: Some(serde_json::value::to_raw_value(&Bytes::from(data)).unwrap()),
            }),
            Answer::TransportFailure => failure(-32005, "rate limit exceeded"),
        }
    }

    /// `eth_estimateGas` answers [`MOCK_GAS_ESTIMATE`] for a call whose handler
    /// returns, and the handler's revert for one that reverts.
    fn estimate_gas(&self, params: &Value) -> ResponsePayload {
        let to: Address = serde_json::from_value(params[0]["to"].clone()).unwrap();
        match self.answer(to, &calldata(&params[0])) {
            Answer::Return(_) => success(&json!(format!("0x{MOCK_GAS_ESTIMATE:x}"))),
            Answer::Revert(data) => ResponsePayload::Failure(ErrorPayload {
                code: 3,
                message: "execution reverted".into(),
                data: Some(serde_json::value::to_raw_value(&Bytes::from(data)).unwrap()),
            }),
            Answer::TransportFailure => failure(-32005, "rate limit exceeded"),
        }
    }

    fn answer(&self, to: Address, input: &[u8]) -> Answer {
        let selector: [u8; 4] = input[..4].try_into().unwrap();
        let handler = self.lock().handlers.get(&(to, selector)).cloned();
        match handler {
            Some(handler) => handler(input),
            None => panic!(
                "the mock endpoint has no answer for selector 0x{} on {to}",
                alloy::hex::encode(selector)
            ),
        }
    }
}

/// What the mock endpoint estimates any call that does not revert to cost.
pub(crate) const MOCK_GAS_ESTIMATE: u64 = 200_000;

/// The input bytes of a transaction or call object, whichever key carries them.
pub(crate) fn calldata(tx: &Value) -> Vec<u8> {
    let hex = tx["input"].as_str().or_else(|| tx["data"].as_str()).unwrap_or("0x");
    alloy::hex::decode(hex).unwrap()
}

fn success(value: &Value) -> ResponsePayload {
    ResponsePayload::Success(serde_json::value::to_raw_value(value).unwrap())
}

fn failure(code: i64, message: &str) -> ResponsePayload {
    ResponsePayload::Failure(ErrorPayload { code, message: message.to_owned().into(), data: None })
}

fn receipt(hash: B256, tx: &Value, logs: &[alloy::rpc::types::Log]) -> Value {
    json!({
        "transactionHash": hash,
        "transactionIndex": "0x0",
        "blockHash": B256::repeat_byte(0xbb),
        "blockNumber": "0x1",
        "from": tx["from"],
        "to": tx["to"],
        "cumulativeGasUsed": "0x5208",
        "gasUsed": "0x5208",
        "effectiveGasPrice": "0x1",
        "contractAddress": null,
        "logs": logs,
        "logsBloom": format!("0x{}", "00".repeat(256)),
        "type": "0x2",
        "status": "0x1",
    })
}

impl tower::Service<RequestPacket> for MockRpc {
    type Response = ResponsePacket;
    type Error = TransportError;
    type Future = TransportFut<'static>;

    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, packet: RequestPacket) -> Self::Future {
        let this = self.clone();
        Box::pin(async move {
            match packet {
                RequestPacket::Single(request) => {
                    let payload = this.handle(&request);
                    Ok(ResponsePacket::Single(Response { id: request.id().clone(), payload }))
                }
                RequestPacket::Batch(_) => {
                    Err(TransportErrorKind::custom_str("the mock endpoint takes no batches"))
                }
            }
        })
    }
}

/// A log `address` emitted, as a receipt carries it.
pub(crate) fn log_from(
    address: Address,
    data: alloy::primitives::LogData,
) -> alloy::rpc::types::Log {
    alloy::rpc::types::Log {
        inner: alloy::primitives::Log { address, data },
        ..alloy::rpc::types::Log::default()
    }
}

/// A wad amount's raw integer, for readability in assertions.
pub(crate) fn u(value: u128) -> U256 {
    U256::from(value)
}

#[cfg(test)]
mod tests {
    //! What goes on the wire for quote tokens, curves, pools and launches.

    use alloy::primitives::aliases::{I24, U24};
    use alloy::primitives::{Address, B256, I256, U256, address};
    use alloy::sol_types::{SolCall, SolEvent};

    use super::{Answer, MOCK_GAS_ESTIMATE, MockRpc, calldata, log_from, u};
    use crate::amount::{NATIVE_USDC, QuoteAmount, QuoteTokenInfo, Tokens, Usdc};
    use crate::bindings::curve::BondingCurve;
    use crate::bindings::erc20::IERC20Metadata;
    use crate::bindings::fee_hook::ArcNowFeeHook;
    use crate::bindings::launchpad::Launchpad;
    use crate::bindings::multicall3::IMulticall3;
    use crate::bindings::quote_registry::QuoteRegistry;
    use crate::bindings::router::UniswapV4Router04;
    use crate::bindings::token::ArcToken;
    use crate::bindings::v4_migrator::UniswapV4Migrator;
    use crate::constants::MULTICALL3;
    use crate::curve::BuyRequest;
    use crate::deadline::Deadline;
    use crate::error::Error;
    use crate::launchpad::LaunchParams;
    use crate::network::{Network, NetworkConfig};
    use crate::pool::{PoolBuyRequest, erc20_allowance_slot};

    const EURC: Address = address!("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a");
    const W18: Address = address!("0x0000000000000000000000000000000000001818");
    const OWNER: Address = address!("0x00000000000000000000000000000000000a11ce");
    const SPENDER: Address = address!("0x000000000000000000000000000000000000beef");
    const CURVE: Address = address!("0x000000000000000000000000000000000000c0e1");
    const TOKEN: Address = address!("0x00000000000000000000000000000000000070c3");
    const REGISTRY: Address = address!("0x00000000000000000000000000000000000000aa");
    const SCALE: u128 = 1_000_000_000_000;

    fn eurc() -> QuoteTokenInfo {
        QuoteTokenInfo::erc20(EURC, "EURC", "EURC", 6).unwrap()
    }

    fn euros(text: &str) -> QuoteAmount {
        QuoteAmount::parse_in(&eurc(), text).unwrap()
    }

    fn arc() -> NetworkConfig {
        Network::ArcTestnet.config().clone()
    }

    fn not_representable(err: &Error) -> bool {
        matches!(err, Error::QuoteAmountNotRepresentable { quote_scale, .. } if *quote_scale == u(SCALE))
    }

    // ------------------------------------------------------- the allowance flow

    #[tokio::test]
    async fn native_usdc_needs_no_allowance_and_asks_the_chain_nothing() {
        let mock = MockRpc::new();
        let client = mock.client(arc(), Some(OWNER));
        let outcome = client
            .quote_token_for(NATIVE_USDC)
            .ensure_allowance(SPENDER, &Usdc::from_whole(5))
            .await
            .unwrap();
        assert!(!outcome.approved);
        assert_eq!(outcome.tx_hash, None);
        assert_eq!(outcome.allowance, None);
        assert!(mock.requests().is_empty(), "{:?}", mock.requests());
        let err = client.quote_token_for(NATIVE_USDC).allowance(OWNER, SPENDER).await.unwrap_err();
        assert!(matches!(err, Error::InvalidArgument { .. }), "{err:?}");
        assert!(mock.requests().is_empty());
    }

    #[tokio::test]
    async fn an_allowance_that_already_covers_the_amount_sends_nothing() {
        let mock = MockRpc::new();
        mock.on::<IERC20Metadata::allowanceCall>(EURC, |call| {
            assert_eq!((call.owner, call.spender), (OWNER, SPENDER));
            Answer::Return(IERC20Metadata::allowanceCall::abi_encode_returns(&u(2_000_000)))
        });
        let client = mock.client(arc(), Some(OWNER));
        let outcome =
            client.quote_token_for(eurc()).ensure_allowance(SPENDER, &euros("1.5")).await.unwrap();
        assert!(!outcome.approved);
        assert_eq!(outcome.tx_hash, None);
        assert_eq!(outcome.allowance, Some(euros("2")));
        assert_eq!(mock.count("eth_sendTransaction"), 0);
        assert_eq!(mock.count("eth_call"), 1);
    }

    #[tokio::test]
    async fn a_short_allowance_is_topped_up_by_an_exact_approve_and_nothing_more() {
        let mock = MockRpc::new();
        mock.returns::<IERC20Metadata::allowanceCall>(EURC, u(1_499_999));
        let client = mock.client(arc(), Some(OWNER));
        let outcome =
            client.quote_token_for(eurc()).ensure_allowance(SPENDER, &euros("1.5")).await.unwrap();
        assert!(outcome.approved);
        assert!(outcome.tx_hash.is_some());
        assert_eq!(outcome.allowance, Some(euros("1.5")));
        let sent = mock.sent();
        assert_eq!(sent.len(), 1, "one approve and nothing else: {sent:?}");
        assert_eq!(sent[0]["to"].as_str().unwrap().to_lowercase(), EURC.to_string().to_lowercase());
        assert_eq!(
            calldata(&sent[0]),
            IERC20Metadata::approveCall { spender: SPENDER, amount: u(1_500_000) }.abi_encode(),
            "exactly the raw amount, never a max approval"
        );
        assert!(mock.count("eth_getTransactionReceipt") >= 1, "the approval is waited for");
    }

    // ------------------------------------------------ refused before any RPC

    #[tokio::test]
    async fn an_amount_the_quote_cannot_carry_is_refused_before_any_rpc() {
        let mock = MockRpc::new();
        let client = mock.client(arc(), Some(OWNER));
        let dusty = QuoteAmount::from_wad_in(&eurc(), u(SCALE + 1));

        let err = client.quote_token_for(eurc()).approve(SPENDER, &dusty).await.unwrap_err();
        assert!(not_representable(&err), "approve: {err:?}");
        let err =
            client.quote_token_for(eurc()).ensure_allowance(SPENDER, &dusty).await.unwrap_err();
        assert!(not_representable(&err), "ensure_allowance: {err:?}");
        let err = client
            .curve(CURVE)
            .buy(BuyRequest::new(dusty.clone(), Tokens::ZERO))
            .await
            .unwrap_err();
        assert!(not_representable(&err), "curve buy: {err:?}");
        let err = client
            .pool(TOKEN)
            .buy(PoolBuyRequest::new(dusty.clone(), Tokens::ZERO, Deadline::in_minutes(5)))
            .await
            .unwrap_err();
        assert!(not_representable(&err), "pool buy: {err:?}");
        let err = client
            .launchpad()
            .unwrap()
            .launch(&LaunchParams::new("Example", "EXMPL", "ipfs://x").initial_buy(dusty))
            .await
            .unwrap_err();
        assert!(not_representable(&err), "launch: {err:?}");

        assert!(mock.requests().is_empty(), "nothing reached the endpoint: {:?}", mock.requests());
    }

    // ------------------------------------------------------------ the curve

    fn a_version_3_eurc_curve(mock: &MockRpc) {
        mock.returns::<BondingCurve::VERSIONCall>(CURVE, "arcnow/bonding-curve@4.0.0".to_owned());
        mock.returns::<BondingCurve::quoteTokenCall>(CURVE, EURC);
        mock.returns::<BondingCurve::quoteDecimalsCall>(CURVE, 6);
    }

    fn trade_log(buy: bool, quote_wad: U256, tokens_wad: U256) -> alloy::rpc::types::Log {
        log_from(
            CURVE,
            BondingCurve::Trade {
                curve: CURVE,
                token: TOKEN,
                trader: OWNER,
                isBuy: buy,
                quoteAmountWad: quote_wad,
                tokenAmountWad: tokens_wad,
                feeQuoteWad: quote_wad / u(100),
                newVirtualReserveWad: U256::ZERO,
                newTokensSold: tokens_wad,
                newPriceWad: U256::ZERO,
            }
            .encode_log_data(),
        )
    }

    #[tokio::test]
    async fn an_erc20_curve_buy_approves_exactly_then_calls_buy_with_quote_with_no_value() {
        let mock = MockRpc::new();
        a_version_3_eurc_curve(&mock);
        mock.returns::<IERC20Metadata::allowanceCall>(EURC, U256::ZERO);
        a_buy_with_quote_that_simulates(&mock);
        mock.receipt_logs(|tx| {
            let input = calldata(tx);
            if input[..4] == BondingCurve::buyWithQuoteCall::SELECTOR {
                vec![trade_log(true, u(2 * SCALE * 1_000_000), u(7_000))]
            } else {
                vec![]
            }
        });
        let client = mock.client(arc(), Some(OWNER));
        let request = BuyRequest::new(euros("2"), Tokens::from_wad(u(6_000)))
            .deadline(Deadline::at(1_800_000_000))
            .referrer(SPENDER);
        let filled = client.curve(CURVE).buy(request).await.unwrap();
        assert_eq!(filled.tokens_out, Tokens::from_wad(u(7_000)));
        assert_eq!(filled.quote_spent, euros("2"));
        assert_eq!(filled.quote_spent.token(), &eurc());
        assert!(filled.approval_tx_hash.is_some());

        let sent = mock.sent();
        assert_eq!(sent.len(), 2, "{sent:?}");
        assert_eq!(
            calldata(&sent[0]),
            IERC20Metadata::approveCall { spender: CURVE, amount: u(2_000_000) }.abi_encode()
        );
        assert_eq!(
            calldata(&sent[1]),
            BondingCurve::buyWithQuoteCall {
                quoteInWad: u(2 * SCALE * 1_000_000),
                minTokensOutWad: u(6_000),
                deadline: u(1_800_000_000),
                r#ref: SPENDER,
            }
            .abi_encode()
        );
        let value = sent[1]["value"].as_str().unwrap_or("0x0");
        assert_eq!(U256::from_str_radix(value.trim_start_matches("0x"), 16).unwrap(), U256::ZERO);
    }

    fn a_buy_with_quote_that_simulates(mock: &MockRpc) {
        mock.on::<BondingCurve::buyWithQuoteCall>(CURVE, |_| {
            Answer::Return(BondingCurve::buyWithQuoteCall::abi_encode_returns(
                &BondingCurve::buyWithQuoteReturn {
                    tokensOutWad: U256::ZERO,
                    quoteSpentWad: U256::ZERO,
                    refundWad: U256::ZERO,
                },
            ))
        });
    }

    /// Revert data no contract of ours defines: the SDK must still refuse.
    fn a_revert() -> Answer {
        Answer::Revert(vec![0xde, 0xad, 0xbe, 0xef])
    }

    /// The state override an `eth_call` to `to` carried for `token`, if any.
    fn override_on(mock: &MockRpc, to: Address, token: Address) -> Option<serde_json::Value> {
        mock.requests()
            .into_iter()
            .filter(|(m, p)| {
                m == "eth_call"
                    && p[0]["to"].as_str().is_some_and(|t| t.eq_ignore_ascii_case(&to.to_string()))
            })
            .find_map(|(_, p)| {
                p.get(2)?.as_object()?.iter().find_map(|(k, v)| {
                    k.eq_ignore_ascii_case(&token.to_string()).then(|| v.clone())
                })
            })
    }

    fn has_slot(diff: &serde_json::Value, slot: B256) -> bool {
        diff["stateDiff"].as_object().is_some_and(|d| {
            d.len() == 1 && d.keys().any(|k| k.eq_ignore_ascii_case(&slot.to_string()))
        })
    }

    #[tokio::test]
    async fn an_erc20_curve_buy_that_would_revert_is_refused_before_any_approval() {
        let mock = MockRpc::new();
        a_version_3_eurc_curve(&mock);
        mock.returns::<IERC20Metadata::allowanceCall>(EURC, U256::ZERO);
        mock.on::<BondingCurve::buyWithQuoteCall>(CURVE, |_| a_revert());
        let client = mock.client(arc(), Some(OWNER));
        let request = BuyRequest::new(euros("2"), Tokens::from_wad(u(6_000)));
        client.curve(CURVE).buy(request).await.unwrap_err();
        assert!(
            mock.sent().is_empty(),
            "no approval is left behind for a buy that reverts: {:?}",
            mock.sent()
        );
        let diff = override_on(&mock, CURVE, EURC)
            .expect("the buy was simulated with an allowance override");
        assert!(has_slot(&diff, erc20_allowance_slot(OWNER, CURVE, U256::from(10))), "{diff}");
    }

    #[tokio::test]
    async fn an_erc20_curve_buy_that_spends_less_than_offered_reports_the_rest_as_refund() {
        let mock = MockRpc::new();
        a_version_3_eurc_curve(&mock);
        // Already approved: nothing to approve; the buy is still estimated.
        mock.returns::<IERC20Metadata::allowanceCall>(EURC, u(2_000_000));
        a_buy_with_quote_that_simulates(&mock);
        mock.receipt_logs(|_| vec![trade_log(true, u(1_500_000 * SCALE), u(7_000))]);
        let client = mock.client(arc(), Some(OWNER));
        let filled =
            client.curve(CURVE).buy(BuyRequest::new(euros("2"), Tokens::ZERO)).await.unwrap();
        assert_eq!(filled.quote_spent, euros("1.5"));
        assert_eq!(filled.refund, euros("0.5"), "an ERC-20 buy pulls only what it spends");
        assert!(filled.approval_tx_hash.is_none());
        assert_eq!(mock.sent().len(), 1, "the buy alone");
    }

    fn gas_of(tx: &serde_json::Value) -> Option<u64> {
        tx["gas"].as_str().map(|hex| u64::from_str_radix(hex.trim_start_matches("0x"), 16).unwrap())
    }

    #[test]
    fn quote_transfer_headroom_is_a_fifth_or_150k_whichever_is_more() {
        use crate::quote::with_quote_transfer_headroom as headroom;
        assert_eq!(headroom(100_000), 250_000, "a fifth is 20,000: the 150,000 floor applies");
        assert_eq!(headroom(750_000), 900_000, "at 750,000 a fifth IS 150,000");
        assert_eq!(headroom(1_000_000), 1_200_000, "a fifth of a large estimate");
        assert_eq!(headroom(u64::MAX), u64::MAX, "saturates rather than wrapping");
    }

    #[test]
    fn pool_quote_transfer_headroom_is_a_fifth_or_400k_whichever_is_more() {
        // Review L-1: a pool swap's estimate can miss the hook's fee redemption and
        // distribution, and each ERC-20 share then needs 111,587 gas left before it.
        use crate::quote::with_pool_quote_transfer_headroom as headroom;
        assert_eq!(headroom(100_000), 500_000, "the 400,000 floor applies");
        assert_eq!(headroom(2_000_000), 2_400_000, "at 2,000,000 a fifth IS 400,000");
        assert_eq!(headroom(3_000_000), 3_600_000, "a fifth of a large estimate");
        assert_eq!(headroom(u64::MAX), u64::MAX, "saturates rather than wrapping");
    }

    #[test]
    fn an_empty_revert_is_out_of_gas_only_on_an_erc20_quote() {
        let named = Error::EmptyRevert.on_erc20_quote(&eurc(), Some(300_000));
        assert!(
            matches!(&named, Error::QuoteTransferOutOfGas { symbol, gas_limit: Some(300_000) } if symbol == "EURC"),
            "{named:?}"
        );
        assert!(named.to_string().contains("tryPushBounded"), "{named}");
        assert!(matches!(
            Error::EmptyRevert.on_erc20_quote(&NATIVE_USDC, None),
            Error::EmptyRevert
        ));
        assert!(matches!(Error::ZeroAmount.on_erc20_quote(&eurc(), None), Error::ZeroAmount));
    }

    #[tokio::test]
    async fn an_erc20_curve_buy_is_sent_with_the_estimate_plus_headroom() {
        let mock = MockRpc::new();
        a_version_3_eurc_curve(&mock);
        mock.returns::<IERC20Metadata::allowanceCall>(EURC, u(2_000_000));
        a_buy_with_quote_that_simulates(&mock);
        mock.receipt_logs(|_| vec![trade_log(true, u(2 * SCALE * 1_000_000), u(7_000))]);
        let client = mock.client(arc(), Some(OWNER));
        client.curve(CURVE).buy(BuyRequest::new(euros("2"), Tokens::ZERO)).await.unwrap();
        let sent = mock.sent();
        assert_eq!(sent.len(), 1, "{sent:?}");
        assert_eq!(
            gas_of(&sent[0]),
            Some(MOCK_GAS_ESTIMATE + 150_000),
            "never the bare estimate: the fee-share gas guard sits right at its edge"
        );
    }

    #[tokio::test]
    async fn an_erc20_curve_buy_whose_estimate_reverts_empty_is_named_out_of_gas() {
        let mock = MockRpc::new();
        a_version_3_eurc_curve(&mock);
        mock.returns::<IERC20Metadata::allowanceCall>(EURC, u(2_000_000));
        mock.on::<BondingCurve::buyWithQuoteCall>(CURVE, |_| Answer::Revert(vec![]));
        let client = mock.client(arc(), Some(OWNER));
        let err = client
            .curve(CURVE)
            .buy(BuyRequest::new(euros("2"), Tokens::ZERO).gas_limit(300_000))
            .await
            .unwrap_err();
        assert!(
            matches!(&err, Error::QuoteTransferOutOfGas { symbol, gas_limit: None } if symbol == "EURC"),
            "{err:?}"
        );
        assert!(mock.sent().is_empty(), "refused before sending");
    }

    #[tokio::test]
    async fn a_caller_gas_limit_on_an_erc20_curve_buy_is_raised_to_the_safe_minimum_never_lowered()
    {
        for (asked, sent) in [(100_000, MOCK_GAS_ESTIMATE + 150_000), (900_000, 900_000)] {
            let mock = MockRpc::new();
            a_version_3_eurc_curve(&mock);
            mock.returns::<IERC20Metadata::allowanceCall>(EURC, u(2_000_000));
            a_buy_with_quote_that_simulates(&mock);
            mock.receipt_logs(|_| vec![trade_log(true, u(2 * SCALE * 1_000_000), u(7_000))]);
            let client = mock.client(arc(), Some(OWNER));
            client
                .curve(CURVE)
                .buy(BuyRequest::new(euros("2"), Tokens::ZERO).gas_limit(asked))
                .await
                .unwrap();
            assert_eq!(gas_of(&mock.sent()[0]), Some(sent), "asked for {asked}");
        }
    }

    #[tokio::test]
    async fn a_version_2_curve_is_refused_before_anything_is_priced() {
        let mock = MockRpc::new();
        mock.returns::<BondingCurve::VERSIONCall>(CURVE, "arcnow/bonding-curve@2.0.0".to_owned());
        let client = mock.client(arc(), None);
        let err = client.curve(CURVE).quote_buy(Usdc::from_whole(1)).await.unwrap_err();
        assert!(
            matches!(&err, Error::UnknownCurveVersion { version } if version == "arcnow/bonding-curve@2.0.0"),
            "{err:?}"
        );
        assert_eq!(mock.count("eth_call"), 1, "VERSION() and nothing else");
    }

    #[tokio::test]
    async fn a_curve_quoted_in_another_currency_is_a_mismatch() {
        let mock = MockRpc::new();
        a_version_3_eurc_curve(&mock);
        let client = mock.client(arc(), None);
        let err = client.curve(CURVE).quote_buy(Usdc::from_whole(1)).await.unwrap_err();
        assert!(
            matches!(err, Error::QuoteTokenMismatch { expected, actual } if expected == EURC && actual == Address::ZERO),
            "{err:?}"
        );
        // And the curve's quote is read once, then cached with its version.
        let before = mock.count("eth_call");
        assert_eq!(client.curve(CURVE).quote_token().await.unwrap(), eurc());
        assert_eq!(mock.count("eth_call"), before);
    }

    // ------------------------------------------------------- quote metadata

    #[tokio::test]
    async fn quote_metadata_comes_from_networks_json_then_one_cached_multicall() {
        let mock = MockRpc::new();
        let client = mock.client(arc(), None);
        assert_eq!(client.quote_token_info(EURC).await.unwrap(), eurc());
        assert_eq!(client.quote_token_info(Address::ZERO).await.unwrap(), NATIVE_USDC);
        assert!(mock.requests().is_empty(), "networks.json answers without RPC");

        // A transport failure is reported and NOT cached.
        mock.on::<IERC20Metadata::symbolCall>(W18, |_| Answer::TransportFailure);
        mock.returns::<IERC20Metadata::nameCall>(W18, "Eighteen".to_owned());
        mock.returns::<IERC20Metadata::decimalsCall>(W18, 18);
        assert!(client.quote_token_info(W18).await.is_err());
        mock.returns::<IERC20Metadata::symbolCall>(W18, "W18".to_owned());
        let calls = mock.count("eth_call");
        let info = client.quote_token_info(W18).await.unwrap();
        assert_eq!((info.symbol.as_ref(), info.decimals, info.is_native), ("W18", 18, false));
        assert_eq!(mock.count("eth_call"), calls + 1, "symbol, name and decimals in ONE call");
        client.quote_token_info(W18).await.unwrap();
        assert_eq!(mock.count("eth_call"), calls + 1, "and cached");
    }

    #[tokio::test]
    async fn spend_state_is_one_multicall_for_either_kind_of_quote() {
        let mock = MockRpc::new();
        mock.on::<IMulticall3::getEthBalanceCall>(MULTICALL3, |call| {
            assert_eq!(call.addr, OWNER);
            Answer::Return(IMulticall3::getEthBalanceCall::abi_encode_returns(&u(
                5 * 10u128.pow(18)
            )))
        });
        mock.returns::<IERC20Metadata::balanceOfCall>(EURC, u(3_250_000));
        mock.returns::<IERC20Metadata::allowanceCall>(EURC, u(1_000_000));
        let client = mock.client(arc(), None);

        let native =
            client.quote_token_for(NATIVE_USDC).spend_state(OWNER, Some(SPENDER)).await.unwrap();
        assert_eq!(native.balance, Usdc::from_whole(5));
        assert_eq!(native.allowance, None);
        assert_eq!(mock.count("eth_call"), 1);

        let erc20 = client.quote_token_for(eurc()).spend_state(OWNER, Some(SPENDER)).await.unwrap();
        assert_eq!(erc20.balance, euros("3.25"));
        assert_eq!(erc20.allowance, Some(euros("1")));
        assert_eq!(mock.count("eth_call"), 2);
        assert_eq!(mock.count("eth_getBalance"), 0);
    }

    // ------------------------------------------------------- the registry

    fn a_registry(mock: &MockRpc) {
        mock.returns::<QuoteRegistry::VERSIONCall>(
            REGISTRY,
            "arcnow/quote-registry@1.0.0".to_owned(),
        );
        mock.returns::<QuoteRegistry::quoteTokenCountCall>(REGISTRY, u(3));
        mock.on::<QuoteRegistry::quoteTokenAtCall>(REGISTRY, |call| {
            let at = [Address::ZERO, EURC, W18][call.i.to::<usize>()];
            Answer::Return(QuoteRegistry::quoteTokenAtCall::abi_encode_returns(&at))
        });
        mock.on::<QuoteRegistry::quoteInfoCall>(REGISTRY, |call| {
            let (decimals, fee, active) = match call.quote {
                q if q == Address::ZERO => (18, u(2 * 10u128.pow(18)), true),
                q if q == EURC => (6, u(2 * 10u128.pow(18)), true),
                _ => (18, u(10u128.pow(18)), false),
            };
            Answer::Return(QuoteRegistry::quoteInfoCall::abi_encode_returns(
                &QuoteRegistry::quoteInfoReturn { decimals, launchFeeWad: fee, active },
            ))
        });
        mock.returns::<IERC20Metadata::symbolCall>(W18, "W18".to_owned());
        mock.returns::<IERC20Metadata::nameCall>(W18, "Eighteen".to_owned());
        mock.returns::<IERC20Metadata::decimalsCall>(W18, 18);
    }

    #[tokio::test]
    async fn the_quote_registry_lists_in_at_most_three_calls() {
        let mock = MockRpc::new();
        a_registry(&mock);
        let mut config = arc();
        config.contracts.quote_registry = Some(REGISTRY);
        let client = mock.client(config, None);
        let registry = client.quote_registry().await.unwrap();
        assert_eq!(registry.address(), REGISTRY);
        let listed = registry.list().await.unwrap();
        assert!(mock.count("eth_call") <= 3, "{} calls", mock.count("eth_call"));
        assert_eq!(listed.len(), 3);
        assert_eq!(listed[0].token, NATIVE_USDC);
        assert_eq!(listed[1].token, eurc());
        assert_eq!(listed[1].launch_fee, euros("2"));
        assert!(listed[1].active);
        assert_eq!(listed[2].token.symbol, "W18");
        assert!(!listed[2].active);
    }

    #[tokio::test]
    async fn the_registry_address_is_asked_of_the_launchpad_once() {
        let mock = MockRpc::new();
        let mut config = arc();
        // The preset records the deployed registry; a network that does not
        // records None, and the launchpad is asked for it exactly once.
        assert!(config.contracts.quote_registry.is_some(), "the preset records one");
        config.contracts.quote_registry = None;
        let launchpad = config.contracts.launchpad.unwrap();
        mock.returns::<Launchpad::quoteTokenRegistryCall>(launchpad, REGISTRY);
        let client = mock.client(config, None);
        assert_eq!(client.quote_registry().await.unwrap().address(), REGISTRY);
        assert_eq!(client.quote_registry().await.unwrap().address(), REGISTRY);
        assert_eq!(mock.count("eth_call"), 1);
    }

    #[tokio::test]
    async fn a_version_2_quote_registry_is_refused() {
        let mock = MockRpc::new();
        a_registry(&mock);
        mock.returns::<QuoteRegistry::VERSIONCall>(
            REGISTRY,
            "arcnow/quote-registry@2.0.0".to_owned(),
        );
        let mut config = arc();
        config.contracts.quote_registry = Some(REGISTRY);
        let client = mock.client(config, None);
        let err = client.quote_registry().await.unwrap().list().await.unwrap_err();
        assert!(matches!(err, Error::UnknownCurveVersion { .. }), "{err:?}");
    }

    // ----------------------------------------------------------- the pool

    /// A graduated token whose EURC pool has the TOKEN as currency0.
    fn a_token_first_eurc_pool(mock: &MockRpc, config: &NetworkConfig) -> (Address, Address) {
        an_eurc_pool(mock, config, TOKEN)
    }

    /// A graduated `token`'s EURC pool, its key sorted by address as v4 sorts it.
    fn an_eurc_pool(mock: &MockRpc, config: &NetworkConfig, token: Address) -> (Address, Address) {
        let migrator = address!("0x00000000000000000000000000000000000000d2");
        let manager = config.v4.pool_manager.unwrap();
        let router = config.contracts.v4_router.unwrap();
        let hook = address!("0x00000000000000000000000000000000000000cc");
        mock.returns::<ArcToken::migratedPoolCall>(token, manager);
        mock.returns::<ArcToken::migratorCall>(token, migrator);
        mock.returns::<UniswapV4Migrator::poolKeyCall>(
            migrator,
            UniswapV4Migrator::PoolKey {
                currency0: token.min(EURC),
                currency1: token.max(EURC),
                fee: U24::from(3_000),
                tickSpacing: I24::unchecked_from(60),
                hooks: hook,
            },
        );
        mock.returns::<UniswapV4Migrator::poolIdOfCall>(migrator, B256::repeat_byte(0x77));
        mock.returns::<UniswapV4Migrator::poolManagerCall>(migrator, manager);
        mock.returns::<UniswapV4Migrator::VERSIONCall>(
            migrator,
            "arcnow/uniswap-v4-migrator@2.0.0".to_owned(),
        );
        mock.returns::<UniswapV4Router04::poolManagerCall>(router, manager);
        mock.returns::<ArcNowFeeHook::VERSIONCall>(
            hook,
            "arcnow/arc-now-fee-hook@4.0.0".to_owned(),
        );
        (router, hook)
    }

    fn packed(amount0: i128, amount1: i128) -> I256 {
        let mut bytes = [0_u8; 32];
        bytes[..16].copy_from_slice(&amount0.to_be_bytes());
        bytes[16..].copy_from_slice(&amount1.to_be_bytes());
        I256::from_raw(U256::from_be_bytes(bytes))
    }

    #[tokio::test]
    async fn an_erc20_pool_buy_quote_overrides_only_the_routers_allowance_and_reads_raw_legs() {
        let mock = MockRpc::new();
        let config = arc();
        let (router, _) = a_token_first_eurc_pool(&mock, &config);
        mock.on::<UniswapV4Router04::swapExactTokensForTokensCall>(router, |call| {
            assert!(!call.zeroForOne, "the quote is currency1, so a buy is one-for-zero");
            assert_eq!(call.amountIn, u(1_000_000), "raw EURC, not a wad");
            // Token first: amount0 is the tokens received, amount1 the EURC paid.
            Answer::Return(UniswapV4Router04::swapExactTokensForTokensCall::abi_encode_returns(
                &packed(123_456_000_000_000_000_000, -1_000_000),
            ))
        });
        let client = mock.client(config, None);
        let quote = client.pool(TOKEN).quote_buy_as(euros("1"), OWNER).await.unwrap();
        assert_eq!(quote.quote_in, euros("1"));
        assert_eq!(quote.tokens_out, Tokens::from_wad(u(123_456_000_000_000_000_000)));
        assert_eq!(quote.fee_quote, euros("0.008"), "the hook's 0.80% of 1 EURC");

        let (_, params) = mock
            .requests()
            .into_iter()
            .rev()
            .find(|(m, p)| {
                m == "eth_call"
                    && p[0]["to"].as_str().unwrap().eq_ignore_ascii_case(&router.to_string())
            })
            .expect("the swap was simulated against the router");
        let overrides = &params[2];
        let slot = erc20_allowance_slot(OWNER, router, U256::from(10));
        let eurc_override = overrides
            .as_object()
            .unwrap()
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(&EURC.to_string()))
            .map(|(_, v)| v.clone())
            .expect("the EURC allowance is overridden via networks.json's allowanceSlot");
        let diff = eurc_override["stateDiff"].as_object().unwrap();
        assert_eq!(diff.len(), 1);
        assert!(diff.keys().any(|k| k.eq_ignore_ascii_case(&slot.to_string())), "{diff:?}");
        let owner_override = overrides
            .as_object()
            .unwrap()
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(&OWNER.to_string()))
            .map(|(_, v)| v.clone());
        assert!(
            owner_override.is_none_or(|o| o.get("stateDiff").is_none() && o.get("state").is_none()),
            "the buyer's own EURC balance is never overridden"
        );
    }

    #[tokio::test]
    async fn an_erc20_pool_buy_quote_without_a_known_slot_overrides_no_allowance() {
        let mock = MockRpc::new();
        let mut config = arc();
        config.quote_allowance_slots.clear();
        let (router, _) = a_token_first_eurc_pool(&mock, &config);
        mock.returns::<UniswapV4Router04::swapExactTokensForTokensCall>(
            router,
            packed(5_000, -1_000_000),
        );
        let client = mock.client(config, None);
        client.pool(TOKEN).quote_buy_as(euros("1"), OWNER).await.unwrap();
        let (_, params) = mock
            .requests()
            .into_iter()
            .rev()
            .find(|(m, p)| {
                m == "eth_call"
                    && p[0]["to"].as_str().unwrap().eq_ignore_ascii_case(&router.to_string())
            })
            .unwrap();
        let touched_eurc = params[2]
            .as_object()
            .is_some_and(|o| o.keys().any(|k| k.eq_ignore_ascii_case(&EURC.to_string())));
        assert!(!touched_eurc, "no slot, no override: {params}");
    }

    #[tokio::test]
    async fn a_pool_quote_in_another_currency_is_a_mismatch() {
        let mock = MockRpc::new();
        let config = arc();
        a_token_first_eurc_pool(&mock, &config);
        let client = mock.client(config, None);
        assert_eq!(client.pool(TOKEN).quote_token().await.unwrap(), eurc());
        assert!(!client.pool(TOKEN).quote_is_currency0().await.unwrap());
        let err = client.pool(TOKEN).quote_buy(Usdc::from_whole(1)).await.unwrap_err();
        assert!(
            matches!(err, Error::QuoteTokenMismatch { expected, .. } if expected == EURC),
            "{err:?}"
        );
    }

    /// A token address above EURC's, so EURC sorts first and is currency0.
    const QUOTE_FIRST_TOKEN: Address = address!("0xf0000000000000000000000000000000000070c3");

    #[tokio::test]
    async fn an_erc20_pool_trade_in_either_orientation_swaps_in_the_quotes_direction() {
        for (token, quote_first) in [(TOKEN, false), (QUOTE_FIRST_TOKEN, true)] {
            let mock = MockRpc::new();
            let config = arc();
            let (router, _) = an_eurc_pool(&mock, &config, token);
            mock.returns::<IERC20Metadata::allowanceCall>(EURC, U256::ZERO);
            mock.returns::<ArcToken::allowanceCall>(token, U256::MAX);
            mock.on::<UniswapV4Router04::swapExactTokensForTokensCall>(router, move |call| {
                let (amount0, amount1) =
                    if call.zeroForOne { (-1_000_000, 5_000) } else { (5_000, -1_000_000) };
                Answer::Return(UniswapV4Router04::swapExactTokensForTokensCall::abi_encode_returns(
                    &packed(amount0, amount1),
                ))
            });
            let client = mock.client(config, Some(OWNER));
            let pool = client.pool(token);
            assert_eq!(pool.quote_is_currency0().await.unwrap(), quote_first, "{token}");

            // A buy: an exact raw approval of the router, then the swap with no value.
            let _ = pool
                .buy(PoolBuyRequest::new(euros("1"), Tokens::ZERO, Deadline::in_minutes(5)))
                .await;
            let sent = mock.sent();
            assert_eq!(sent.len(), 2, "approve, then swap: {sent:?}");
            assert_eq!(
                calldata(&sent[0]),
                IERC20Metadata::approveCall { spender: router, amount: u(1_000_000) }.abi_encode(),
                "a plain ERC-20 approval of the router for the raw spend, no Permit2"
            );
            let buy =
                UniswapV4Router04::swapExactTokensForTokensCall::abi_decode(&calldata(&sent[1]))
                    .unwrap();
            assert_eq!(
                buy.zeroForOne, quote_first,
                "a buy swaps zeroForOne exactly when the quote is currency0"
            );
            assert_eq!(buy.amountIn, u(1_000_000), "raw EURC in");
            assert_eq!(buy.poolKey.currency0, token.min(EURC), "the key as the migrator sorted it");
            let value = sent[1]["value"].as_str().unwrap_or("0x0");
            assert_eq!(
                U256::from_str_radix(value.trim_start_matches("0x"), 16).unwrap(),
                U256::ZERO
            );

            // A sell: the opposite direction, the token amount in wad.
            let _ = pool
                .sell(crate::pool::PoolSellRequest::new(
                    Tokens::from_whole(1),
                    euros("0.5"),
                    Deadline::in_minutes(5),
                ))
                .await;
            let sent = mock.sent();
            let sell = UniswapV4Router04::swapExactTokensForTokensCall::abi_decode(&calldata(
                sent.last().unwrap(),
            ))
            .unwrap();
            assert_eq!(sell.zeroForOne, !quote_first, "a sell is the opposite direction");
            assert_eq!(sell.amountIn, Tokens::from_whole(1).to_wad());
            assert_eq!(sell.amountOutMin, u(500_000), "the floor in raw EURC");
        }
    }

    #[tokio::test]
    async fn a_caller_gas_limit_on_an_erc20_pool_swap_is_raised_never_lowered() {
        let mock = MockRpc::new();
        let config = arc();
        let (router, _) = a_token_first_eurc_pool(&mock, &config);
        mock.returns::<IERC20Metadata::allowanceCall>(EURC, u(1_000_000_000_000_000_000));
        mock.returns::<ArcToken::allowanceCall>(TOKEN, U256::MAX);
        mock.returns::<UniswapV4Router04::swapExactTokensForTokensCall>(
            router,
            packed(5_000, -1_000_000),
        );
        let client = mock.client(config, Some(OWNER));
        let pool = client.pool(TOKEN);
        let _ = pool
            .buy(
                PoolBuyRequest::new(euros("1"), Tokens::ZERO, Deadline::in_minutes(5))
                    .gas_limit(100_000),
            )
            .await;
        let _ = pool
            .sell(
                crate::pool::PoolSellRequest::new(
                    Tokens::from_whole(1),
                    euros("0.5"),
                    Deadline::in_minutes(5),
                )
                .gas_limit(1_000_000),
            )
            .await;
        let gas: Vec<_> = mock.sent().iter().map(gas_of).collect();
        // Review L-1: an ERC-20-quoted pool swap gets at least 400,000 over the estimate.
        assert_eq!(gas, vec![Some(MOCK_GAS_ESTIMATE + 400_000), Some(1_000_000)]);
    }

    #[tokio::test]
    async fn an_erc20_pool_sell_whose_estimate_reverts_empty_is_named_out_of_gas() {
        let mock = MockRpc::new();
        let config = arc();
        let (router, _) = a_token_first_eurc_pool(&mock, &config);
        mock.returns::<ArcToken::allowanceCall>(TOKEN, U256::MAX);
        mock.on::<UniswapV4Router04::swapExactTokensForTokensCall>(router, |_| {
            Answer::Revert(vec![])
        });
        let client = mock.client(config, Some(OWNER));
        let err = client
            .pool(TOKEN)
            .sell(crate::pool::PoolSellRequest::new(
                Tokens::from_whole(1),
                euros("0.5"),
                Deadline::in_minutes(5),
            ))
            .await
            .unwrap_err();
        assert!(
            matches!(&err, Error::QuoteTransferOutOfGas { symbol, gas_limit: None } if symbol == "EURC"),
            "{err:?}"
        );
        assert!(mock.sent().is_empty());
    }

    #[tokio::test]
    async fn an_erc20_pool_buy_that_would_revert_is_refused_before_any_approval() {
        let mock = MockRpc::new();
        let config = arc();
        let (router, _) = a_token_first_eurc_pool(&mock, &config);
        mock.returns::<IERC20Metadata::allowanceCall>(EURC, U256::ZERO);
        mock.on::<UniswapV4Router04::swapExactTokensForTokensCall>(router, |_| a_revert());
        let client = mock.client(config, Some(OWNER));
        client
            .pool(TOKEN)
            .buy(PoolBuyRequest::new(euros("1"), Tokens::ZERO, Deadline::in_minutes(5)))
            .await
            .unwrap_err();
        assert!(
            mock.sent().is_empty(),
            "no approval is left behind for a swap that reverts: {:?}",
            mock.sent()
        );
        let diff = override_on(&mock, router, EURC)
            .expect("the swap was simulated with an allowance override");
        assert!(has_slot(&diff, erc20_allowance_slot(OWNER, router, U256::from(10))), "{diff}");
    }

    #[tokio::test]
    async fn a_pool_sell_floor_is_rounded_up_to_a_whole_raw_unit() {
        let mock = MockRpc::new();
        let config = arc();
        let (router, _) = a_token_first_eurc_pool(&mock, &config);
        mock.returns::<ArcToken::allowanceCall>(TOKEN, U256::MAX);
        mock.returns::<UniswapV4Router04::swapExactTokensForTokensCall>(
            router,
            packed(5_000, -1_000_000),
        );
        let client = mock.client(config, Some(OWNER));
        // One wad above one EURC: a floor of 1.000000 would accept less.
        let floor = QuoteAmount::from_wad_in(&eurc(), u(1_000_000 * SCALE + 1));
        // The receipt has no fill in it; only what was sent matters here.
        let _ = client
            .pool(TOKEN)
            .sell(crate::pool::PoolSellRequest::new(
                Tokens::from_whole(1),
                floor,
                Deadline::in_minutes(5),
            ))
            .await;
        let sent = mock.sent();
        assert_eq!(sent.len(), 1, "{sent:?}");
        let swap = UniswapV4Router04::swapExactTokensForTokensCall::abi_decode(&calldata(&sent[0]))
            .unwrap();
        assert_eq!(swap.amountOutMin, u(1_000_001), "rounded up, never down");
        assert!(sent[0]["to"].as_str().unwrap().eq_ignore_ascii_case(&router.to_string()));
    }

    /// A launchpad and platform whose EURC template targets 50 EURC, and whose
    /// registry charges a 2 EURC launch fee - a registry-defined value, so the
    /// path that pays one is exercised even though arcnow.io's registries charge 0.
    fn a_eurc_launchpad(mock: &MockRpc, config: &NetworkConfig) -> Address {
        use crate::bindings::platform_config::{IPlatformConfig, PlatformConfig};
        let launchpad = config.contracts.launchpad.unwrap();
        let platform = config.contracts.arcnow_platform.unwrap();
        mock.returns::<Launchpad::VERSIONCall>(launchpad, "arcnow/launchpad@3.0.0".to_owned());
        mock.returns::<PlatformConfig::VERSIONCall>(
            platform,
            "arcnow/platform-config@4.0.0".to_owned(),
        );
        mock.returns::<Launchpad::quoteLaunchCall>(
            launchpad,
            Launchpad::quoteLaunchReturn {
                launchFeeWad: u(2_000_000 * SCALE),
                nativeValueWad: U256::ZERO,
                tokensOutWad: u(5_000),
                tradeFeeWad: u(10_000 * SCALE),
            },
        );
        mock.returns::<PlatformConfig::curveParametersForCall>(
            platform,
            IPlatformConfig::CurveParameters {
                totalSupplyWad: u(1_000_000) * u(SCALE * 1_000_000),
                curveSupplyWad: u(791_000) * u(SCALE * 1_000_000),
                y0Wad: u(1),
                r0Wad: u(1),
                targetQuoteWad: u(50) * u(SCALE * 1_000_000),
                initialPriceWad: u(1),
            },
        );
        mock.returns::<IERC20Metadata::allowanceCall>(EURC, u(1_000_000_000_000_000_000));
        mock.returns::<Launchpad::launchCall>(
            launchpad,
            Launchpad::launchReturn { token: TOKEN, curve: CURVE, tokensOutWad: u(5_000) },
        );
        launchpad
    }

    #[tokio::test]
    async fn a_caller_gas_limit_on_an_erc20_launch_is_raised_never_lowered() {
        use crate::launchpad::{GRADUATION_GAS_FLOOR, GRADUATION_GAS_LIMIT};
        let cases = [
            // An ordinary launch: the estimate plus headroom is the minimum.
            ("1", Some(100_000), Some(MOCK_GAS_ESTIMATE + 150_000)),
            ("1", Some(900_000), Some(900_000)),
            // A graduating launch: GRADUATION_GAS_LIMIT is.
            ("60", None, Some(GRADUATION_GAS_LIMIT)),
            ("60", Some(GRADUATION_GAS_FLOOR), Some(GRADUATION_GAS_LIMIT)),
            ("60", Some(9_000_000), Some(9_000_000)),
        ];
        for (initial_buy, asked, sent) in cases {
            let mock = MockRpc::new();
            let config = arc();
            a_eurc_launchpad(&mock, &config);
            let client = mock.client(config, Some(OWNER));
            let mut params =
                LaunchParams::new("Example", "EXMPL", "ipfs://x").initial_buy(euros(initial_buy));
            if let Some(limit) = asked {
                params = params.gas_limit(limit);
            }
            let _ = client.launchpad().unwrap().launch(&params).await;
            assert_eq!(
                gas_of(&mock.sent()[0]),
                sent,
                "initial buy {initial_buy}, asked for {asked:?}"
            );
        }

        // Below the floor on a graduating launch is still refused, before sending.
        let mock = MockRpc::new();
        let config = arc();
        a_eurc_launchpad(&mock, &config);
        let client = mock.client(config, Some(OWNER));
        let starved = LaunchParams::new("Example", "EXMPL", "ipfs://x")
            .initial_buy(euros("60"))
            .gas_limit(GRADUATION_GAS_FLOOR - 1);
        let err = client.launchpad().unwrap().launch(&starved).await.unwrap_err();
        assert!(matches!(err, Error::LaunchGasLimitTooLow { .. }), "{err:?}");
        assert!(mock.sent().is_empty());
    }

    #[tokio::test]
    async fn an_erc20_launch_that_would_revert_is_refused_before_any_approval() {
        use crate::bindings::platform_config::{IPlatformConfig, PlatformConfig};
        let mock = MockRpc::new();
        let config = arc();
        let launchpad = config.contracts.launchpad.unwrap();
        let platform = config.contracts.arcnow_platform.unwrap();
        mock.returns::<Launchpad::VERSIONCall>(launchpad, "arcnow/launchpad@3.0.0".to_owned());
        mock.returns::<PlatformConfig::VERSIONCall>(
            platform,
            "arcnow/platform-config@4.0.0".to_owned(),
        );
        mock.returns::<Launchpad::quoteLaunchCall>(
            launchpad,
            Launchpad::quoteLaunchReturn {
                launchFeeWad: u(2_000_000 * SCALE),
                nativeValueWad: U256::ZERO,
                tokensOutWad: u(5_000),
                tradeFeeWad: u(10_000 * SCALE),
            },
        );
        mock.returns::<PlatformConfig::curveParametersForCall>(
            platform,
            IPlatformConfig::CurveParameters {
                totalSupplyWad: u(1_000_000) * u(SCALE * 1_000_000),
                curveSupplyWad: u(791_000) * u(SCALE * 1_000_000),
                y0Wad: u(1),
                r0Wad: u(1),
                targetQuoteWad: u(50) * u(SCALE * 1_000_000),
                initialPriceWad: u(1),
            },
        );
        mock.returns::<IERC20Metadata::allowanceCall>(EURC, U256::ZERO);
        mock.on::<Launchpad::launchCall>(launchpad, |_| a_revert());
        let client = mock.client(config, Some(OWNER));
        client
            .launchpad()
            .unwrap()
            .launch(&LaunchParams::new("Example", "EXMPL", "ipfs://x").initial_buy(euros("1")))
            .await
            .unwrap_err();
        assert!(
            mock.sent().is_empty(),
            "no approval is left behind for a launch that reverts: {:?}",
            mock.sent()
        );
        let diff = override_on(&mock, launchpad, EURC)
            .expect("the launch was simulated with an allowance override");
        assert!(has_slot(&diff, erc20_allowance_slot(OWNER, launchpad, U256::from(10))), "{diff}");
    }
}
