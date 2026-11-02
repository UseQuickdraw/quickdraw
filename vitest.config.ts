import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    // The pump SDKs' ESM builds import named exports from CJS anchor; let Vite handle the interop.
    server: { deps: { inline: [/@pump-fun\//] } },
  },
});
