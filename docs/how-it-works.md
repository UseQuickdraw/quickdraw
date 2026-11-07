# How Quickdraw works

Everything happens in the extension: the content script draws the panel on the page, and the extension's service worker holds the wallet, keeps markets live, and builds, signs and sends trades. The only network calls are to the RPC, WebSocket and sender you configure ([getting a Helius key](helius-api-key.md)), and to Telegram if you turn on alerts.

## From a page to a market

The panel passes the worker whatever address the page shows. The worker resolves it to a mint (the page may show the mint, a bonding curve, a pool or a token account), then opens the first market that can trade it. It subscribes to that market's state accounts over WebSocket, so a click quotes and builds locally with no RPC round-trip.

## Supported markets

| Market | Buy | Sell |
|---|---|---|
| pump.fun curve | `buy_exact_quote_in_v3` (exact SOL in, min tokens out) | `sell_v3` |
| pump.fun curve, cashback coins | `buy_v2` (exact tokens out, cost ≤ SOL + slippage) | `sell_v2` |
| PumpSwap (SOL pools) | `buy` (exact tokens out, cost ≤ SOL + slippage; SOL wrapped and unwrapped in the same tx) | `sell` |
| Raydium LaunchLab (SOL-paired curves: letsbonk.fun, stonk.fun…) | `buy_exact_in` | `sell_exact_in` |
| Raydium CPMM (graduated coins, SOL-paired) | `swap_base_input` (exact SOL in, min tokens out) | `swap_base_input` (exact tokens in, min SOL out) |
| Raydium AMM v4 (coins that graduated before PumpSwap, and older SOL pairs) | `swap_base_in_v2` (exact SOL in, min tokens out) | `swap_base_in_v2` (exact tokens in, min SOL out) |
| A coin's own Raydium CLMM or Orca Whirlpool pool, against SOL or USDC | Jupiter `route_v2` through that pool | the same route reversed |
| Meteora Dynamic Bonding Curve (SOL-paired curves: Bags, Believe, Jupiter Studio�) | `swap2` exact in (a buy past the end of the curve fills what's left and returns the rest of the SOL) | `swap2` exact in |
| Meteora DAMM v2 (graduated bonding-curve coins and other SOL pools) | `swap2` exact in | `swap2` exact in |
| Any of the above priced in another token | Jupiter `route_v2`: SOL → that token, then that token → the coin | the same route reversed |

Coins priced in another token are routed through SOL in one transaction:

- **STONK** (most stonk.fun coins): SOL → STONK on its Orca pool.
- **Another pump coin** (e.g. MEIMEI/MeiMei): SOL → that coin on its own PumpSwap pool.
- **An xStock** (TSLAx, INTCx, LLY…) or another token with a SOL pool: SOL → the token on its deepest Raydium CLMM or Orca pool.
- **A token whose liquidity is against USDC** (e.g. NEURALINK): SOL → USDC on Orca, then USDC → the token.
- **A pump coin whose own pool is priced in yet another token** (e.g. Sling1M/BTC, where BTC is priced in WBTC): SOL → WBTC → BTC → Sling1M.

When a token's SOL pools are shallow (under 20 SOL), the deepest of these options, valued in SOL, wins. A pool only counts if it can actually fill a small trade both ways, so one holding a little SOL but no liquidity near the price is passed over.

Raydium CLMM pools with **dynamic fees** work too. Their fee rises with recent volatility: each swap steps one tick group at a time, and the fee is recomputed from a volatility accumulator that decays with time since the pool's last trade, exactly as the program does it (`states/pool_fee.rs`). Newer "customizable" pools, often the dynamic-fee ones, are found by their two mints, since their address includes a seed.

The routes are built locally as Jupiter `route_v2` instructions from Jupiter's on-chain IDL. **No Jupiter API is called.** Jupiter hands each leg exactly what the previous one produced, so nothing is left behind in between, and enforces the final minimum. The pools are found from their addresses with no API, and priced with ports of each program's own swap maths, so quotes match the chain to the unit.

Meteora's bonding curves and DAMM v2 pools are priced from ports of the programs' own maths (MeteoraAg `dynamic-bonding-curve` and `damm-v2`): the curve's segments in square-root price, fixed, time-scheduled, market-cap-scheduled and rate-limited base fees, the volatility fee, fees taken from the input or the output as the pool is set up, and DAMM v2's compounding (constant-product) pools. A graduated curve coin's DAMM v2 pool is found by address: it derives from the two mints and one of the seven configs Meteora's curves migrate into, so reading those few addresses finds it even on RPCs that refuse program scans. Other coins opened from their mint are found by a filtered program scan of each program, since their pool addresses derive from a config the page doesn't show; a page that shows the curve or pool skips the scan. When a curve fills, the panel follows the coin to the DAMM v2 pool it migrates to.

A curve that completes between clicks is followed to its new pool before quoting. A sell that would need more SOL than a curve holds is refused before signing.

### Transfer fees ("tax")

Coins with a Token-2022 transfer fee work: the fee comes off what you receive, and the slippage minimum applies to that amount. Their token account is left open after a full sell, because Token-2022 won't close an account holding withheld fees. A quote token with a transfer fee (the PreStocks such as NEURALINK charge 1%) is priced on PumpSwap pools and pump.fun curves; LaunchLab, Raydium CPMM and Meteora still refuse one.

### Fitting long routes in one transaction

Routes through several pools are too big for one transaction without **address lookup tables**. Quickdraw borrows, in the background, the public tables recent trades on the same pools used. If no public table covers a route, your wallet makes **its own** the first time: one small setup transaction (about 0.0013 SOL of rent, plus about 0.0002 SOL per address, refundable if the table is closed). The panel says when it's doing this, and the signing guard checks that transaction separately.

### Not supported yet

Each of these shows a message saying so:

- coins paired with a token that has no PumpSwap pool and no Raydium CLMM or Orca pool against SOL or USDC (tokens whose only liquidity is on Meteora DLMM, for example);
- coins that graduated from a Meteora curve to a DAMM v1 pool, and Raydium AMM v4 pools that are paired with another token or still trade through OpenBook;
- Meteora DLMM pools, Meteora curves whose coin has a transfer hook, and routed trades through a Meteora curve or pool during its launch rate limit (direct SOL trades work);
- pump.fun cashback curves priced in a token other than SOL;
- the rarer fixed-price and linear curves;
- Raydium CLMM trades that would reach resting limit orders, Orca pools with adaptive fees, and quote tokens with a transfer hook.

## Sending and confirmation

- **Where it goes:** Helius Sender by default (`/fast`; Eco adds `swqos_only=true`, MEV protection adds `mev-protect=true`, your API key is added if set). It can also go through your own RPC (no tip) or a custom URL (**Settings → Safety → Send via**).
- **Retries are ours:** no preflight, and no retries by the endpoint. The worker watches for confirmation over WebSocket and by polling every 400 ms, and rebroadcasts the **same signed transaction** every 1.5 s until it lands or its blockhash expires (about 60–90 s).
- **Never re-signs:** an expired trade is reported as "Expired, not landed", nothing is spent, and you decide whether to click again. Re-signing is what causes double buys.
- **Timing:** the pop-up shows how long the trade took from send to its first block, and to confirmation by the cluster's votes.
- **Built before you click:** while the pointer is on a trade button, the worker quotes and builds that trade (unsigned) and rebuilds it whenever the pool or your holding changes. A click whose build still matches the current state only signs and sends, which saves 3–6 ms on a direct trade and 25–85 ms on a routed one. Anything stale (the pool moved, a new blockhash, changed settings or fees) is built afresh, so a click never signs an old quote. The pop-up's timing says which it was.
- **Warm connection:** while live, the worker pings Sender after 5 s without a send, so the next click doesn't pay a TLS handshake.
- **Rate limits:** every RPC call and send is retried on HTTP 429, at once and then with short pauses, for up to 30 s (20 s for sends).

Compute-unit limits start from mainnet measurements (`DEFAULT_CU` in `src/solana/fees.ts`), then rise with your own trades (the largest recent use plus headroom), never below those measurements: a run of cheap trades mustn't leave a costlier one short.

## Positions and PnL

Every trade that lands through Quickdraw is read back from chain and booked per coin. Failed transactions are booked too, since they still pay the network fee.

- **Bought / sold:** the SOL that went into or came out of the trade itself. The network fee, the tip and token-account rent are tracked separately, so bought + fee + tip + rent equals the wallet change Solscan shows.
- **PnL** = value of what you hold at the live price + sold − bought − the network fees, priority fees and tips paid (failed trades' fees included), in SOL and % of what you bought. Only coins bought with Quickdraw count; tokens bought elsewhere have no cost basis here.
- **Saved vs a 1% platform fee:** 1% of all the volume you've traded here.
- **Options → Ledger** lists positions and exports every fill as CSV, with a latency log below it (click → sent, sent → landed, slot, rebroadcasts).

## Telegram alerts

**Settings → Telegram alerts** connects your own bot: make one with @BotFather, message it once, and paste its token. The worker then calls Telegram's Bot API directly (`sendMessage` on `api.telegram.org`, a host permission asked for when you connect) when a trade made here lands, fails or expires, and when a trade made elsewhere shows up: a recent buy or sell of a coin you've opened, found on chain by the same check that books it (an Axiom take-profit, say), that this wallet didn't send. Each kind can be turned off. Alerts are sent a second apart, and only while the browser is open, since nothing runs anywhere else. The bot token is sealed like the endpoints and never exported with settings.

## Wallets and keys

The key is sealed in `chrome.storage.local` with a non-extractable device key the browser generates, so there's no password and the panel is ready whenever the browser is open. The decrypted key lives only in the service worker's memory. See [SECURITY.md](../SECURITY.md) for the threat model and its limits.
