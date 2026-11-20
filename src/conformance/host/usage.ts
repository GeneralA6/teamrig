import assert from 'node:assert/strict';
import type { CallUsage, UsageMeter } from '../../plugin-api/index.ts';
import { defineContract, type ContractCase, type Subject } from '../contract.ts';

/**
 * What a usage meter sees: nothing of the host's. A case hands the meter a call's usage in the shape the transcript
 * reader gives every host's, so the world holds no line and no format.
 */
export type UsageWorld = Readonly<Record<string, never>>;

export type UsageSubject = Subject<UsageMeter, UsageWorld>;
export type UsageCase = ContractCase<UsageMeter, UsageWorld, 'host'>;

const KINDS = ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheWriteUnsplit', 'cacheRead', 'output'] as const satisfies readonly (keyof CallUsage)[];

/** The kinds the model was sent; the output is what it wrote back. */
const SENT = KINDS.filter((kind) => kind !== 'output');

const NONE: CallUsage = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnsplit: 0, cacheRead: 0, output: 0 };
const MIXED: CallUsage = { input: 40, cacheWrite5m: 80, cacheWrite1h: 100, cacheWriteUnsplit: 200, cacheRead: 10_000, output: 300 };

/** A call that used `count` tokens of one kind and nothing else. */
function only(kind: keyof CallUsage, count: number): CallUsage {
  return { ...NONE, [kind]: count };
}

/** Whether two prices are one number, a rounding step of the sum apart at most. */
function near(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected));
}

const CASES: readonly UsageCase[] = [
  {
    id: 'usage.unused-call-free',
    title: 'prices a call that used no token at nothing, and reads its context as empty',
    features: ['budget.usage', 'context.size'],
    run: ({ port }) => {
      assert.equal(port.ofCall(NONE), 0);
      assert.equal(port.contextReading(NONE), 0);
    },
  },
  {
    id: 'usage.kinds-priced',
    title: 'gives every kind of token a price that is a number and never below nothing, one kind at least above it',
    features: ['budget.usage'],
    run: ({ port }) => {
      const prices = KINDS.map((kind) => port.weights[kind]);
      assert.ok(prices.every((price) => Number.isFinite(price) && price >= 0), JSON.stringify(port.weights));
      assert.ok(prices.some((price) => price > 0), 'no kind of token costs anything');
    },
  },
  {
    id: 'usage.call-sums-its-kinds',
    title: 'prices a call as the sum of its tokens, each kind at the price the meter names for it',
    features: ['budget.usage'],
    run: ({ port }) => {
      for (const kind of KINDS) {
        const cost = port.ofCall(only(kind, 12));
        assert.ok(near(cost, 12 * port.weights[kind]), `12 ${kind} tokens cost ${cost}, at a named price of ${port.weights[kind]} each`);
      }
      const sum = KINDS.reduce((total, kind) => total + MIXED[kind] * port.weights[kind], 0);
      assert.ok(near(port.ofCall(MIXED), sum), `a mixed call cost ${port.ofCall(MIXED)}, its kinds ${sum}`);
    },
  },
  {
    id: 'usage.tool-output-sized',
    title: 'says how many characters of tool output make one token, a number above nothing',
    features: ['budget.usage'],
    run: ({ port }) => {
      assert.ok(Number.isFinite(port.charsPerToken) && port.charsPerToken > 0, String(port.charsPerToken));
    },
  },
  {
    id: 'usage.context-counts-sent',
    title: 'reads tokens the model was sent, cached or not, as context',
    features: ['context.size'],
    run: ({ port }) => {
      for (const kind of SENT) {
        assert.ok(port.contextReading(only(kind, 12)) > 0, `12 ${kind} tokens read as no context`);
      }
    },
  },
  {
    id: 'usage.context-leaves-output',
    title: "leaves the reply's output out of the context the call read",
    features: ['context.size'],
    run: ({ port }) => {
      assert.equal(port.contextReading(only('output', 300)), 0);
      assert.equal(port.contextReading(MIXED), port.contextReading({ ...MIXED, output: 0 }));
    },
  },
];

const WORLD: UsageWorld = {};

/** A liar that claims the port and meters nothing: every price, every call and every context is 0. */
export function nothingUsage(): UsageSubject {
  return { world: WORLD, port: { weights: NONE, charsPerToken: 0, ofCall: () => 0, contextReading: () => 0 } };
}

/** A liar that says yes to all: a call costs 1 whatever it used, and everything in it, its output too, is context. */
export function yesUsage(): UsageSubject {
  const weights = { input: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheWriteUnsplit: 1, cacheRead: 1, output: 1 };
  const all = (usage: CallUsage): number => KINDS.reduce((total, kind) => total + usage[kind], 0);
  return { world: WORLD, port: { weights, charsPerToken: 1, ofCall: () => 1, contextReading: all } };
}

/** What every host's usage meter must do with a call's usage. */
export const USAGE_CONTRACT = defineContract<UsageMeter, UsageWorld, 'host'>({
  port: 'usage',
  side: 'host',
  cases: CASES,
  liars: [nothingUsage, yesUsage],
});
