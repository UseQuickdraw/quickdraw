# Getting a Helius API key

Quickdraw talks to Solana through an **RPC**: the service that reads prices and balances and sends your trades. [Helius](https://www.helius.dev) is the easiest one to set up, and its **free plan is enough to start**. It takes about two minutes.

## 1. Make a free Helius account

1. Go to **[helius.dev](https://www.helius.dev)** and click **Start for free** (or **Sign up**).
2. Sign up with your email, Google or GitHub, or connect a wallet.
3. When it asks you to pick a plan, choose **Free**. You don't need a card.

## 2. Copy your API key

1. Open the Helius **dashboard**. You land on it after signing up.
2. Find **API Keys** in the menu. Helius makes your first key for you.
3. Click the copy button next to the key. It looks like this:

```
1a2b3c4d-1111-2222-3333-444455556666
```

You can copy the whole RPC URL instead (`https://mainnet.helius-rpc.com/?api-key=…`). Quickdraw accepts either.

## 3. Paste it into Quickdraw

1. Open Quickdraw's setup page. It opens by itself after you install it; otherwise click the Quickdraw icon in your toolbar, then **Settings**.
2. On the **Endpoints** step, paste the key into **Quick setup**.
3. Quickdraw fills in everything for you: the RPC URL, the WebSocket URL and the Sender key. Click **Save endpoints**.
4. Your browser asks whether Quickdraw may connect to Helius. Click **Allow**. Quickdraw only asks for the addresses you entered.
5. A connection test runs. When it passes, you're done.

## Good to know

- **Keep the key to yourself.** Anyone with it can use your Helius quota. Never post it in an issue or a screenshot. If it leaks, delete it in the Helius dashboard, make a new one, and paste the new one on the **Endpoints** tab of Quickdraw's options page.
- **The key stays on your computer.** Quickdraw stores it encrypted in your browser and only sends it to Helius.
- **"429 Too Many Requests"** means you've hit the free plan's request limit. Quickdraw retries for you, but if it happens a lot while you trade fast, a paid Helius plan or another provider will help.
- **Other providers work too.** QuickNode, Triton or your own node: paste their full `https://` RPC URL into Quick setup instead. The public `api.mainnet-beta.solana.com` doesn't work, because it blocks browser extensions.
