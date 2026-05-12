// Browser polyfill for Node.js's Buffer global. Required because the
// upstream @solana/spl-token and @solana/web3.js bundles internally
// reference `Buffer` (instruction-data encoding) without checking
// typeof. esbuild does NOT auto-polyfill Node globals; we install
// the `buffer` npm package and assign it to globalThis ourselves.
import { Buffer as BufferPolyfill } from 'buffer';
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = BufferPolyfill;
}
