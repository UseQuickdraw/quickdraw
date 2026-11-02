# Contributing

Thanks for helping make Quickdraw better. Bug reports, coins that don't work yet, and pull requests are all welcome.

## Reporting a coin that doesn't work

[Open an issue](../../issues/new/choose) with the **token address**, the site you were on, and the exact message the panel showed. That's usually enough to find the market it trades on.

## Reporting a bug

Include your browser and Quickdraw version, what you clicked, what you expected, and what happened. A screenshot of the panel and the pop-up helps. **Never share your secret key, backup file or RPC URLs with API keys in them.**

Security problems go through private reporting instead: see [SECURITY.md](SECURITY.md).

## Pull requests

1. Set up the project as described in [docs/development.md](docs/development.md).
2. Keep each pull request to one change, and match the style of the code around it.
3. Add or update tests. Anything that touches how trades are quoted or built should come with a fixture-backed test, and ideally a live simulation (see [testing against mainnet](docs/development.md#testing-against-mainnet)).
4. Make sure these pass:

```bash
npm run typecheck
```

```bash
npm test
```

Ground rules the project won't bend on:

- **Client-side only.** No servers, no telemetry, no third-party trading or price APIs. Routes are built locally.
- **No hidden fees.** Any fee must be opt-in, off by default and shown in the UI.
- **Every transaction passes the guard.** New programs or instructions extend `src/solana/guard.ts` deliberately, with tests.
- **Pinned dependencies.** Exact versions, committed lockfile, no remote code.

By contributing you agree that your work is released under the [MIT license](LICENSE).
