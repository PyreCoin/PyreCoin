// Structural tests for extractBurn — the parser that turns a Solana
// parsed-transaction object into a leaderboard burn record. These
// fixtures mirror the shape returned by getParsedTransaction for
// Token-2022 BurnChecked + Memo Program instructions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBurn, extractInscription } from '../lib/solana.mjs';

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
  const r = extractBurn(parsed, MINT, 6);
  assert.equal(r.amount, 1234);
  assert.equal(r.signer, AUTH);
  assert.equal(r.memo, 'url=foo.xyz | msg=hi');
  assert.equal(r.signature, 'sig-abc');
});

test('extractBurn: burn for a different mint → null', () => {
  const parsed = tx({ instructions: [burnCheckedIx({ mint: OTHER_MINT }), memoIx()] });
  assert.equal(extractBurn(parsed, MINT, 6), null);
});

test('extractBurn: memo without burn → null', () => {
  const parsed = tx({ instructions: [memoIx()] });
  assert.equal(extractBurn(parsed, MINT, 6), null);
});

test('extractBurn: burn without memo → accepted (memo=null)', () => {
  // Memo-less burns are now accepted — rendered with flavor text on
  // the leaderboard. The dust-sweep case that motivated this lives
  // here.
  const parsed = tx({ instructions: [burnCheckedIx({ uiAmount: 695 })] });
  const r = extractBurn(parsed, MINT, 6);
  assert.equal(r.amount, 695);
  assert.equal(r.memo, null);
});

test('extractBurn: failed tx → null', () => {
  const parsed = tx({ instructions: [burnCheckedIx(), memoIx()], err: { InstructionError: [0, 'Custom'] } });
  assert.equal(extractBurn(parsed, MINT, 6), null);
});

test('extractBurn: missing meta → null', () => {
  assert.equal(extractBurn({ transaction: { signatures: ['x'], message: { instructions: [] } } }, MINT, 6), null);
  assert.equal(extractBurn(null, MINT, 6), null);
});

test('extractBurn: CPI burn in inner instructions → counted', () => {
  const parsed = tx({
    instructions: [memoIx()],
    inner: [burnCheckedIx({ uiAmount: 42 })],
  });
  const r = extractBurn(parsed, MINT, 6);
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
  const r = extractBurn(parsed, MINT, 6);
  assert.equal(r.amount, 350);
});

test('extractBurn: plain burn (no tokenAmount) → counted via decimals', () => {
  // Plain (unchecked) burn carries raw lamport amount, no tokenAmount
  // object. With decimals supplied by the caller we can recover the UI
  // units. The dust-sweeper case used plain burn — this is what made
  // it look invisible before.
  const parsed = tx({
    instructions: [
      {
        programId: TOKEN_2022,
        program: 'spl-token-2022',
        parsed: { type: 'burn', info: { account: 'a', mint: MINT, authority: AUTH, amount: '695111601' } },
      },
    ],
  });
  const r = extractBurn(parsed, MINT, 6);
  assert.equal(r.amount, 695.111601);
  assert.equal(r.memo, null);
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
  const r = extractBurn(parsed, MINT, 6);
  assert.equal(r.amount, 1000);
});

// ─── extractInscription ──────────────────────────────────────────

test('extractInscription: tx with memo + fee payer → accepted', () => {
  const parsed = {
    slot: 1,
    blockTime: 1700000000,
    meta: { err: null, innerInstructions: [] },
    transaction: {
      signatures: ['ins-sig-1'],
      message: {
        accountKeys: ['INSCRIBER_WALLET_111111111111111111111111'],
        instructions: [memoIx('msg=hello world')],
      },
    },
  };
  const r = extractInscription(parsed);
  assert.equal(r.memo, 'msg=hello world');
  assert.equal(r.signer, 'INSCRIBER_WALLET_111111111111111111111111');
  assert.equal(r.signature, 'ins-sig-1');
});

test('extractInscription: no memo → null', () => {
  const parsed = {
    slot: 1,
    blockTime: 1700000000,
    meta: { err: null, innerInstructions: [] },
    transaction: {
      signatures: ['ins-sig-2'],
      message: { accountKeys: ['x'], instructions: [] },
    },
  };
  assert.equal(extractInscription(parsed), null);
});

test('extractInscription: failed tx → null', () => {
  const parsed = {
    slot: 1,
    blockTime: 1700000000,
    meta: { err: { InstructionError: [0, 'Custom'] }, innerInstructions: [] },
    transaction: { signatures: ['x'], message: { accountKeys: ['x'], instructions: [memoIx()] } },
  };
  assert.equal(extractInscription(parsed), null);
});
