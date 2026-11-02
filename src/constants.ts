// Core constants. This file must stay free of SDK imports so the content
// script can use it without pulling web3.js / anchor into the page bundle.
// Venue program IDs come from the pinned pump SDKs (see src/venues/*).

export const LAMPORTS_PER_SOL = 1_000_000_000;

export const PROGRAMS = {
  system: '11111111111111111111111111111111',
  computeBudget: 'ComputeBudget111111111111111111111111111111',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  associatedToken: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
} as const;

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Helius Sender, verified against https://www.helius.dev/docs/sending-transactions/sender
// on 2026-10-28. The API key is optional (keyless = 1 req/s per IP, keyed = 50 req/s),
// passed as `?api-key=`. Re-check these whenever Sender starts rejecting transactions.
export const SENDER = {
  globalUrl: 'https://sender.helius-rpc.com/fast',
  pingUrl: 'https://sender.helius-rpc.com/ping',
  /** Sender Max: every pathway + priority tip buffer. */
  minTipFastSol: 0.001,
  /** `swqos_only=true`: single fast path. */
  minTipEcoSol: 0.000005,
  tipAccounts: [
    '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
    'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
    '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
    '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
    '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
    '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
    'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
    '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
    '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
    '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
  ],
} as const;

// Usable from Node (tests) but NOT from the extension: it answers any request
// carrying a browser Origin header with 403 "Access forbidden" (checked 2026-10-28).
export const PUBLIC_MAINNET_RPC = 'https://api.mainnet-beta.solana.com';

/** Absolute ceilings the settings UI cannot exceed, whatever a profile says. */
export const HARD_LIMITS = {
  maxTradeSol: 100,
  maxTipSol: 0.1,
  maxPriorityFeeSol: 0.05,
  // 100% means no price floor at all: the trade lands at whatever price it gets.
  maxSlippagePct: 100,
  minSlippagePct: 0.1,
} as const;

export const KDF = {
  name: 'PBKDF2',
  hash: 'SHA-256',
  /** OWASP 2023+ recommendation for PBKDF2-HMAC-SHA256. */
  iterations: 600_000,
  saltBytes: 16,
  ivBytes: 12,
} as const;

/** Any non-empty password is accepted; the UI warns below WEAK_PASSWORD_LENGTH. */
export const MIN_PASSWORD_LENGTH = 1;
export const WEAK_PASSWORD_LENGTH = 8;

export const SWEEP_CONFIRM_PHRASE = 'SWEEP ALL SOL';
