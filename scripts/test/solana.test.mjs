// Structural tests for extractBurn — the parser that turns a Solana
// parsed-transaction object into a leaderboard burn record. These
// fixtures mirror the shape returned by getParsedTransaction for
// Token-2022 BurnChecked + Memo Program instructions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBurn } from '../lib/solana.mjs';

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const MINT = 'PYRE_TEST_MINT_111111111111111111111111111';
const OTHER_MINT = 'OTHER_TEST_MINT_2222222222222222222222222';
const AUTH = 'AUTHORITY_WALLET_111111111111111111111111';

function tx({ instructions = [], inner = [], err = null, sig = 'sig-abc', slot = 1, blockTime = 1700000000 } = {}) {
  return {
    slot,
    blockTime,
    meta: { err, innerInstructions: inner.length ? [{ index: 0, instructions: inner }] : [] },
    transaction: {
      signatures: [sig],
      message: { accountKeys: [], instructions },
    },
  };
}

function burnCheckedIx({ mint = MINT, authority = AUTH, uiAmount = 1000, decimals = 6 } = {}) {
  return {
    programId: TOKEN_2022,
    program: 'spl-token-2022',
    parsed: {
      type: 'burnChecked',
      info: {
        account: 'SOURCE_ATA_111111111111111111111111111111',
        mint,
        authority,
        tokenAmount: {
          amount: String(uiAmount * 10 ** decimals),
          decimals,
          uiAmount,
          uiAmountString: String(uiAmount),
        },
      },
    },
  };
}

function memoIx(text = 'url=foo.xyz | msg=hi') {
  return { programId: MEMO, program: 'spl-memo', parsed: text };
}

test('extractBurn: burnChecked + memo for our mint → accepted', () => {
  const parsed = tx({ instructions: [burnCheckedIx({ uiAmount: 1234 }), memoIx()] });
  const r = extractBurn(parsed, MINT);
  assert.equal(r.amount, 1234);
  assert.equal(r.signer, AUTH);
  assert.equal(r.memo, 'url=foo.xyz | msg=hi');
  assert.equal(r.signature, 'sig-abc');
});

test('extractBurn: burn for a different mint → null', () => {
  const parsed = tx({ instructions: [burnCheckedIx({ mint: OTHER_MINT }), memoIx()] });
  assert.equal(extractBurn(parsed, MINT), null);
});

test('extractBurn: memo without burn → null', () => {
  const parsed = tx({ instructions: [memoIx()] });
  assert.equal(extractBurn(parsed, MINT), null);
});

test('extractBurn: burn without memo → null', () => {
  const parsed = tx({ instructions: [burnCheckedIx()] });
  assert.equal(extractBurn(parsed, MINT), null);
});

test('extractBurn: failed tx → null', () => {
  const parsed = tx({ instructions: [burnCheckedIx(), memoIx()], err: { InstructionError: [0, 'Custom'] } });
  assert.equal(extractBurn(parsed, MINT), null);
});

test('extractBurn: missing meta → null', () => {
  assert.equal(extractBurn({ transaction: { signatures: ['x'], message: { instructions: [] } } }, MINT), null);
  assert.equal(extractBurn(null, MINT), null);
});

test('extractBurn: CPI burn in inner instructions → counted', () => {
  const parsed = tx({
    instructions: [memoIx()],
    inner: [burnCheckedIx({ uiAmount: 42 })],
  });
  const r = extractBurn(parsed, MINT);
  assert.equal(r.amount, 42);
  assert.equal(r.signer, AUTH);
});

test('extractBurn: multiple burnChecked in one tx → summed', () => {
  const parsed = tx({
    instructions: [
      burnCheckedIx({ uiAmount: 100 }),
      burnCheckedIx({ uiAmount: 250 }),
      memoIx(),
    ],
  });
  const r = extractBurn(parsed, MINT);
  assert.equal(r.amount, 350);
});

test('extractBurn: plain burn without tokenAmount → skipped', () => {
  // Plain (unchecked) burn parses without a tokenAmount object. We
  // refuse to misinterpret raw lamport-units as UI amounts, so this
  // counts as "no burn detected" — a known minor cost; our website
  // always sends burnChecked, and most CLI/SDK callers do too.
  const parsed = tx({
    instructions: [
      {
        programId: TOKEN_2022,
        program: 'spl-token-2022',
        parsed: { type: 'burn', info: { account: 'a', mint: MINT, authority: AUTH, amount: '1000000' } },
      },
      memoIx(),
    ],
  });
  assert.equal(extractBurn(parsed, MINT), null);
});

test('extractBurn: programId as PublicKey-like object with toString → handled', () => {
  // The web3.js parsed-tx encoder sometimes returns programId as a
  // PublicKey instance (with .toString()) rather than a raw string.
  // The extractor must accept both.
  const ix = burnCheckedIx();
  ix.programId = { toString: () => TOKEN_2022 };
  const memo = memoIx();
  memo.programId = { toString: () => MEMO };
  const parsed = tx({ instructions: [ix, memo] });
  const r = extractBurn(parsed, MINT);
  assert.equal(r.amount, 1000);
});
