# Security

Quickdraw signs transactions without confirmation, so the design assumes the worst about the pages it runs on and limits the damage from bugs.

## Use a burner wallet

- Generate a fresh wallet in the extension, or import one created only for this.
- **Never import your main wallet.** Keep only what you're willing to lose in the burner, and sweep profits back to your main wallet.
- Back up the burner's secret key offline. The optional backup file is encrypted with the password you choose for it.
- There's no password or lock. Anyone who can use this browser profile can trade with the burner and reveal its key from the options page. Use a browser profile only you use.

## Threat model

| Threat | Mitigation |
|---|---|
| Malicious or compromised trading site | The panel runs in an isolated-world content script inside a closed Shadow DOM. The content script never receives key material. It can only send a small set of typed requests (state, panel position, trade intent), and the worker validates each one: mint is a valid pubkey, amounts and slippage in bounds. |
| Key at rest | The key and endpoints are sealed in `chrome.storage.local` with AES-256-GCM (random IV, AAD bound to the wallet pubkey and purpose). The sealing key is a non-extractable WebCrypto key generated in the browser and kept in the extension's IndexedDB: code running as this extension can use it but nothing can read its bytes. A copy of `storage.local` alone, such as a synced or leaked settings file, can't be decrypted. |
| Key in use | The decrypted key lives only in the service worker's memory. It's never written to `chrome.storage.session` or sent to a content script. |
| Backup file | Encrypted with a password chosen just for the file: PBKDF2-SHA256 600k + AES-256-GCM, random salt/IV. Decryption refuses downgraded KDF parameters. |
| Bug or tampering in transaction building | Before signing, `src/solana/guard.ts` inspects the compiled message. It requires exactly one signer (us) and allowlisted programs only. Address lookup tables are allowed only when the builder hands the guard the exact tables it used: the guard expands them and applies every rule to the real addresses, and refuses any other table or any program loaded from one. System transfers may only go to a Sender tip account (≤ max tip) or our own WSOL account. Token instructions are limited to account init, SyncNative and CloseAccount refunding us, and ATA creation to accounts we own. CU price × limit must be ≤ max priority fee. |
| Routed trades (STONK pairs, coins paired with a pump coin, an xStock or a USDC-traded token) | The route goes through Jupiter's on-chain program, built locally from its IDL; no Jupiter API is called. The legs and their accounts are ours, the route's source and destination are our own token accounts, and Jupiter enforces the final minimum. The lookup tables are public and append-only, so an index can't later point at a different account; if one is closed, the trade fails rather than misroutes. A wallet's own table (made when no public one covers a long route) is created and extended by a setup transaction the guard checks separately: only the lookup-table program's create and extend instructions, with the wallet as the table's authority and payer. |
| Double buys | A signed transaction is rebroadcast as-is until it lands or expires, and is never re-signed with a new blockhash. |
| Sweep misuse | The only path where SOL may leave for a non-tip address. It sends to the sweep address saved in settings (never one from a page), requires the typed phrase `SWEEP ALL SOL` from an extension page, and the guard allows exactly one transfer to that one address. |
| Hotkeys firing by accident | Off by default, ignored while typing in page inputs or the panel, and they obey the same caps as clicks. |
| Supply chain | Exact dependency pins plus a committed lockfile, CI on every PR, releases built in CI with checksums, no remote code. The SDK program IDs are asserted in tests. |
| Automations (copytrade) | Off until you create one, and new ones start in dry run. Every automatic buy is trimmed to a per-trade cap and refused past a daily cap, both enforced in the worker; a stop switch halts all of them. Copies go through the same signing guard and fee caps as clicks, and only copy wallets you list. |
| Telegram alerts (off unless you connect a bot) | The worker sends alert text (the trade, the wallet's name, the transaction) to your bot through `api.telegram.org`, so Telegram sees it. The bot token is sealed with the endpoints, never exported with settings, and only sent to Telegram; error messages never echo it. Connecting and changing alerts are extension-page requests only. |
| Rogue extension pages / other extensions | Every message must come from this extension's ID. Privileged requests (reveal, backup, import, delete, endpoints, settings, Telegram alerts) are accepted only from the extension's own pages. |

### Known limitations

- With no password, the device key protects against copying storage files, not against someone using your browser profile or malware that controls the browser. That's the trade-off for a wallet that just works; it's why this is for burners only.
- The key is decoded through a JS string inside the worker, which can't be zeroed. Intermediate byte buffers are zeroed where practical.
- Another installed extension with broad permissions, or malware on your machine, can defeat any browser-extension wallet. Keep the trading browser profile minimal.
- The Axiom integration is unofficial and may break when Axiom changes its site. It only reads an address from the page; it can't cause a trade by itself.
- The sealed vault in `chrome.storage.local` is technically readable by this extension's own content script. It isn't exposed to the page, and the content script never opens it.

## Reporting a vulnerability

Please don't open a public issue for security problems. Use GitHub's **private vulnerability reporting** (Security → Report a vulnerability) on this repository. Include the steps to reproduce and the affected version. We aim to acknowledge reports within a few days.
