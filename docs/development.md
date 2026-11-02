# Development

Quickdraw is a [WXT](https://wxt.dev) Manifest V3 extension written in TypeScript with Preact. Node 20 or newer.

```bash
npm ci
```

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run typecheck
```

`npm run build` writes `.output/chrome-mv3`: load that folder with **Load unpacked** on your browser's extensions page, and click Quickdraw's reload icon after each rebuild. `npm run build:firefox` produces an experimental, untested Firefox build.

## Layout

| Path | What's there |
|---|---|
| `entrypoints/` | The background worker, the content script, the options page and the toolbar popup |
| `src/ui/` | The panel (`Panel.tsx`), its styles, and the options page tabs |
| `src/sites/` | One adapter per supported site: how to find the coin's address and where to put the toolbar button |
| `src/venues/` | One adapter per market, the route legs (Orca, Raydium CLMM, PumpSwap) and the Jupiter `route_v2` builder |
| `src/solana/` | Resolving addresses, the trade engine, the signing guard, sending and confirmation, fees |
| `src/settings/` | The settings schema (zod) and its defaults |
| `src/keystore/`, `src/ledger/` | Sealed wallet storage, and positions/PnL |

### Adding a site

Write one file in `src/sites/` implementing `SiteAdapter`, add its match pattern to `src/sites/matches.ts` and register it in `src/sites/registry.ts`.

### Adding a market

Implement `VenueAdapter` (`src/venues/types.ts`) and add it to `src/venues/registry.ts`. Its `allowedPrograms()` extends the signing guard's allowlist.

## Testing against mainnet

pump.fun has no reliable devnet, so markets are tested against mainnet. Unit tests replay real mainnet snapshots from `tests/fixtures/`. The live tests are skipped unless `LIVE=1`; they re-record those fixtures and **simulate** the exact transactions the extension builds (a buy, a 50% sell, a full sell), with signature checks off, a funded wallet as the buyer and a real holder as the seller. Nothing is signed or sent. Where a program logs what it priced against, our quote on that state must match its output to the unit.

| Test | Covers |
|---|---|
| `tests/live.test.ts` | pump.fun curves (normal and cashback) and PumpSwap |
| `tests/live-sim.test.ts` | Every venue end to end; results go to `quickdraw-live-sim.json` in your temp folder |
| `tests/live-launchlab.test.ts` | Raydium LaunchLab |
| `tests/live-stonk.test.ts` | STONK-paired coins |
| `tests/live-cpmm.test.ts` | Raydium CPMM, SOL-, STONK- and xStock-paired |
| `tests/live-pumproute.test.ts` | PumpSwap coins paired with a pump coin, an xStock or a USDC-traded token |
| `tests/live-clmmpool.test.ts` | A coin on its own CLMM pool priced in an xStock (RETARD/LLY) |

```bash
LIVE=1 npx vitest run tests/live-sim.test.ts
```

Set `LIVE_RPC` to use your own RPC; the public one rate-limits these runs. Each test's header lists the variables that pin a specific pool, mint or holder.

For real trades, use a burner funded with about 0.1 SOL and tiny amounts (0.001–0.01 SOL).

## Verifying a release

Releases are built by GitHub Actions from a tagged commit (`.github/workflows/release.yml`, actions pinned to commit SHAs). To check that a zip matches the source:

1. Check out the release tag.
2. Use the Node major version from the workflow, then run `npm ci && npm run zip`.
3. Compare `sha256sum .output/*-chrome.zip` with the `.sha256` attached to the release.

Two builds of the same commit on the same machine produce a byte-identical zip. If yours differs (a different OS can change the zip container), unzip both and compare the files instead:

```bash
find release-unzipped -type f -exec sha256sum {} + | sort -k2
```

The icons are generated from source too (`npm run icons`). Dependencies are pinned to exact versions and the lockfile is committed. The extension loads no remote code, uses no CDN scripts and does no dynamic `import()` of URLs.

## Promo assets

`npm run teaser` renders `docs/quickdraw-teaser.mp4` and `npm run banner` renders `docs/x-banner.png`, both from canvas pages in `promo/` through headless Edge (set `BROWSER` for Chrome).
