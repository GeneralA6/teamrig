import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_CARD, TEST_GATE, TEST_OWNER_CARD } from '../testing/card.ts';
import { cardLines, cardProblem, cardTexts, gateChoices, gateOf, keptCard, namedTaskIds, parseCard, plainWords, proofWordOf, sameCard, typedHandStep } from './card.ts';
import type { HandStepAudit, RunFiles } from './hand-step.ts';

const WHY_ASK = 'the ordered tier cannot ship at that price';

/** What the CLI read for a card that hands no hand step file: no file. */
const NO_FILES: RunFiles = new Map();

describe('the decision card', () => {
  it('counts the plain words a text says, task ids apart', () => {
    assert.equal(plainWords('30 days: 4 GB'), 4);
    assert.equal(plainWords('option B of T378'), 3);
    assert.equal(plainWords('(T378), T12.'), 0);
    assert.equal(plainWords('T0 and T12x'), 3, 'only an id standing as a word is one');
  });

  it('lists each task id the texts name once, in the order first named', () => {
    assert.deepEqual(namedTaskIds(['T5 before T12', 'then T5 again, and (T7)']), ['T5', 'T12', 'T7']);
    assert.deepEqual(namedTaskIds(['no ids here']), []);
  });

  it('passes a card whose every part reads on its own', () => {
    assert.equal(cardProblem(TEST_CARD, true), undefined);
    assert.equal(cardProblem({ ...TEST_CARD, options: [] }, false), undefined, 'an approval asks yes or no');
  });

  it('refuses a part that is a bare task number, naming the part', () => {
    assert.equal(
      cardProblem({ ...TEST_CARD, options: ['Basic at 9 dollars a month', 'T378 option B'] }, true),
      '--options choice 2 says "T378 option B": give at least 3 plain words besides task ids, so it reads without the task list; --options split into 2 choices at each |: "Basic at 9 dollars a month" / "T378 option B"; write \\| for a | inside a choice',
    );
    assert.match(cardProblem({ ...TEST_CARD, byDefault: 'T5' }, true) ?? '', /^--default says "T5"/);
    assert.match(cardProblem({ ...TEST_CARD, whyAsk: 'see T5' }, true) ?? '', /^--why-ask says "see T5"/);
    assert.equal(cardProblem({ ...TEST_CARD, whyAsk: WHY_ASK }, true), undefined);
  });

  it('shows the choices --options split into when a | inside a choice split it', () => {
    const split = cardProblem({ ...TEST_CARD, options: ["Approve: add the row 'Account", 'D1', "Edit' to the token", 'Decline: keep the token as it is'] }, true) ?? '';
    assert.match(split, /^--options choice 2 says "D1": /);
    assert.match(split, /--options split into 4 choices at each \|: "Approve: add the row 'Account" \/ "D1" \/ "Edit' to the token" \/ "Decline: keep the token as it is"; write \\\| for a \| inside a choice$/);
  });

  it('asks a decision for two options at least, and never takes one alone', () => {
    assert.equal(cardProblem({ ...TEST_CARD, options: [] }, true), '--options lists 0: a decision lists at least 2, separated by |');
    assert.equal(
      cardProblem({ ...TEST_CARD, options: ['Basic at 9 dollars'] }, false),
      '--options lists 1: a decision lists at least 2, separated by |; an approval lists none or as many; --options split into 1 choice at each |: "Basic at 9 dollars"; write \\| for a | inside a choice',
    );
  });

  it('finds a hand step typed into any part of a card, naming the part and its shape (T2312)', () => {
    assert.equal(typedHandStep(TEST_OWNER_CARD), undefined);
    assert.deepEqual(typedHandStep({ ...TEST_CARD, question: 'One paste adds the key file to the guard paths?' }), { flag: '--question', shape: 'an ask to paste' });
    assert.deepEqual(typedHandStep({ ...TEST_CARD, whyAsk: 'only you hold the `settings.json` file' }), { flag: '--why-ask', shape: 'a backticked span' });
    assert.deepEqual(typedHandStep({ ...TEST_CARD, options: ['Basic at 9 dollars', 'add { "tier": "pro" } to the plan'] }), { flag: '--options choice 2', shape: 'a JSON object' });
    assert.deepEqual(typedHandStep({ ...TEST_CARD, recommend: 'Basic, by one Set-Content line' }), { flag: '--recommend', shape: 'a PowerShell write cmdlet' });
    assert.deepEqual(typedHandStep({ ...TEST_CARD, byDefault: "nothing until & 'C:/steps/a.ps1' runs" }), { flag: '--default', shape: "PowerShell's call operator (& ')" });
  });

  it('leaves a card that hands its step as a run file, where its text may name the step (T2312)', () => {
    assert.equal(typedHandStep({ ...TEST_CARD, question: 'Grant read by pasting the line?', run: '/w/tasks/T5/grant-read.ps1' }), undefined);
  });

  it('compares cards part by part', () => {
    assert.equal(sameCard(TEST_CARD, { ...TEST_CARD, options: [...TEST_CARD.options] }), true);
    assert.equal(sameCard(TEST_CARD, { ...TEST_CARD, options: [...TEST_CARD.options].reverse() }), false);
    assert.equal(sameCard(TEST_CARD, { ...TEST_CARD, options: TEST_CARD.options.slice(1) }), false);
    assert.equal(sameCard(TEST_CARD, { ...TEST_CARD, recommend: 'Pro, since it pays more' }), false);
    assert.equal(sameCard(TEST_CARD, { ...TEST_CARD, whyAsk: WHY_ASK }), false);
    assert.equal(sameCard({ ...TEST_CARD, whyAsk: WHY_ASK }, { ...TEST_CARD, whyAsk: WHY_ASK }), true);
    assert.equal(sameCard(TEST_CARD, TEST_OWNER_CARD), false);
    assert.equal(sameCard(TEST_OWNER_CARD, { ...TEST_OWNER_CARD, gate: 'permissions' }), false);
    assert.equal(sameCard(TEST_OWNER_CARD, { ...TEST_CARD, gate: TEST_GATE }), true);
    assert.equal(sameCard(null, null), true);
    assert.equal(sameCard(TEST_CARD, null), false);
  });

  it('reads a card from a register line, or says why it is not one', () => {
    assert.equal(parseCard(undefined), undefined);
    assert.equal(parseCard(null), undefined);
    assert.deepEqual(parseCard({ ...TEST_CARD, extra: 1 }), TEST_CARD, 'a field a newer teamrig adds is ignored');
    assert.equal(parseCard('a card'), 'card is not an object');
    assert.equal(parseCard({ ...TEST_CARD, byDefault: 3 }), 'card needs question, recommend and byDefault as text');
    assert.equal(parseCard({ ...TEST_CARD, options: 'Basic | Pro' }), 'card options is not a list of texts');
    assert.equal(parseCard({ ...TEST_CARD, options: ['Basic', 2] }), 'card options is not a list of texts');
    assert.deepEqual(parseCard({ ...TEST_CARD, whyAsk: WHY_ASK }), { ...TEST_CARD, whyAsk: WHY_ASK });
    assert.equal(parseCard({ ...TEST_CARD, whyAsk: 7 }), 'card whyAsk is not text');
    assert.deepEqual(parseCard(TEST_OWNER_CARD), TEST_OWNER_CARD);
    assert.equal(parseCard({ ...TEST_CARD, gate: ['budget'] }), 'card gate is not text');
  });

  it('prints the question, each option numbered, the recommendation and the default', () => {
    assert.deepEqual(cardTexts(TEST_CARD), [TEST_CARD.question, ...TEST_CARD.options, TEST_CARD.recommend, TEST_CARD.byDefault]);
    assert.deepEqual(cardLines(TEST_CARD, '  ', [], NO_FILES), [
      '  decide: Which pricing tier ships first',
      '    1. Basic at 9 dollars a month',
      '    2. Pro at 29 dollars a month',
      '  recommended: Basic, the cheaper launch',
      '  with no answer: Basic ships on the due date',
    ]);
  });

  it('prints why the owner is asked under the question, and drops it on request', () => {
    const asked = { ...TEST_CARD, whyAsk: WHY_ASK };
    assert.deepEqual(cardTexts(asked), [TEST_CARD.question, WHY_ASK, ...TEST_CARD.options, TEST_CARD.recommend, TEST_CARD.byDefault]);
    assert.deepEqual(cardLines(asked, '  ', [], NO_FILES).slice(0, 2), ['  decide: Which pricing tier ships first', `  why asked: ${WHY_ASK}`]);
    assert.deepEqual(keptCard(asked, { whyAsk: false, gate: true, run: false, affects: false }), TEST_CARD);
    assert.deepEqual(keptCard(asked, { whyAsk: true, gate: true, run: false, affects: false }), asked);
  });

  it('prints the gate that makes it the owner\'s under the question, and drops it on request (T1194)', () => {
    const both = { ...TEST_OWNER_CARD, whyAsk: WHY_ASK };
    assert.deepEqual(cardTexts(both), [TEST_CARD.question, TEST_GATE, WHY_ASK, ...TEST_CARD.options, TEST_CARD.recommend, TEST_CARD.byDefault]);
    assert.deepEqual(cardLines(both, '  ', [], NO_FILES).slice(0, 3), ['  decide: Which pricing tier ships first', `  gate: ${TEST_GATE}`, `  why asked: ${WHY_ASK}`]);
    assert.deepEqual(keptCard(both, { whyAsk: true, gate: false, run: false, affects: false }), { ...TEST_CARD, whyAsk: WHY_ASK });
    assert.deepEqual(keptCard(both, { whyAsk: false, gate: false, run: false, affects: false }), TEST_CARD);
  });

  // T2623: a test, measure or proof of approved work is approved with it, so its card says what it changes.
  describe('a card asking about a test, measure or proof (T2623)', () => {
    const AFFECTS = 'buys 400 dollars of price history';

    it('finds the first proof word a question names, as written, and none inside another word', () => {
      const found = [
        'Approve the back-test design',
        'Run the retests tonight',
        'May I retest the import',
        'Measure the latency first',
        'Take the measurements now',
        'Is this proof enough',
        'Prove the fix on the box',
        'Start a trial of the queue',
        'Do a dry run of the import',
        'A dry-run first',
        'Benchmark the parser',
        'One experiment more',
        'Simulate a full week',
        'Tested both, shall I merge',
      ].map(proofWordOf);
      assert.deepEqual(found, ['back-test', 'retests', 'retest', 'Measure', 'measurements', 'proof', 'Prove', 'trial', 'dry run', 'dry-run', 'Benchmark', 'experiment', 'Simulate', 'Tested']);
      // The one-word spelling is on the scrub's denylist, so it is built at runtime.
      const joined = ['back', 'test'].join('');
      assert.equal(proofWordOf(`Run the ${joined} tonight`), joined);
      assert.deepEqual(['Approve the latest contest price', 'Ship the protest banner', 'An approved immeasurable plan', 'Which pricing tier ships first'].map(proofWordOf), [undefined, undefined, undefined, undefined]);
    });

    it('prints what it affects under the question, checks it as text, compares, reads and keeps it while the owner is asked', () => {
      const tested = { ...TEST_OWNER_CARD, affects: AFFECTS };
      assert.deepEqual(cardTexts(tested), [TEST_CARD.question, TEST_GATE, AFFECTS, ...TEST_CARD.options, TEST_CARD.recommend, TEST_CARD.byDefault]);
      assert.deepEqual(cardLines(tested, '  ', [], NO_FILES).slice(0, 3), ['  decide: Which pricing tier ships first', `  gate: ${TEST_GATE}`, `  affects: ${AFFECTS}`]);
      assert.match(cardProblem({ ...tested, affects: 'T5' }, true) ?? '', /^--affects says "T5"/);
      assert.equal(sameCard(tested, TEST_OWNER_CARD), false);
      assert.equal(sameCard(tested, { ...tested }), true);
      assert.deepEqual(parseCard(tested), tested);
      assert.equal(parseCard({ ...TEST_CARD, affects: 400 }), 'card affects is not text');
      assert.deepEqual(keptCard(tested, { whyAsk: false, gate: true, run: false, affects: true }), tested);
      assert.deepEqual(keptCard(tested, { whyAsk: false, gate: true, run: false, affects: false }), TEST_OWNER_CARD);
    });
  });

  describe('the hand step file a card hands the owner (T2312)', () => {
    const step = '/w/tasks/T5/grant-read.ps1';
    const handed = { ...TEST_OWNER_CARD, run: step };
    const audit: HandStepAudit = { path: step, sha256: 'c'.repeat(64), by: 'gamma', at: '2030-01-07T09:00:00.000Z' };

    it('reads its path as text, and leaves it out of the prose texts', () => {
      assert.deepEqual(parseCard(handed), handed);
      assert.equal(parseCard({ ...TEST_CARD, run: ['/w/a.ps1'] }), 'card run is not text');
      assert.deepEqual(cardTexts(handed), cardTexts(TEST_OWNER_CARD), 'a task id in its path names no task the card is about');
    });

    it('tells a card apart by it, and keeps it only on request', () => {
      assert.equal(sameCard(handed, TEST_OWNER_CARD), false);
      assert.equal(sameCard(handed, { ...TEST_OWNER_CARD, run: '/w/other.ps1' }), false);
      assert.equal(sameCard(handed, { ...handed }), true);
      assert.deepEqual(keptCard(handed, { whyAsk: false, gate: true, run: true, affects: false }), handed);
      assert.deepEqual(keptCard(handed, { whyAsk: false, gate: true, run: false, affects: false }), TEST_OWNER_CARD);
    });

    /** The file as its audit pinned it. */
    const pinned: RunFiles = new Map([[step, audit.sha256]]);

    it('prints the line that runs it last, with its short sha256 and auditor, while the file still has that sha256', () => {
      assert.deepEqual(cardLines(handed, '  ', [audit], pinned).at(-1), `  run: & '${step}'   (sha256 cccccccc, audited by gamma)`);
      assert.deepEqual(cardLines(handed, '  ', [audit], pinned).slice(0, -1), cardLines(TEST_OWNER_CARD, '  ', [audit], pinned));
    });

    it('prints that it is not to be run when no audit on the task pins it', () => {
      assert.equal(cardLines(handed, '  ', [], pinned).at(-1), `  run: do not run ${step}: no audit on the task pins it (core rule 11)`);
      assert.equal(cardLines(handed, '  ', [{ ...audit, path: '/w/other.ps1' }], pinned).at(-1), `  run: do not run ${step}: no audit on the task pins it (core rule 11)`);
    });

    it('prints that it is not to be run once the file changed since its audit, with both short sha256s', () => {
      const changed: RunFiles = new Map([[step, 'd'.repeat(64)]]);
      assert.equal(
        cardLines(handed, '  ', [audit], changed).at(-1),
        `  run: CHANGED since its audit (sha256 cccccccc by gamma, now dddddddd): do not run ${step}; audit it again`,
      );
    });

    it('prints that it is not to be run once the file is gone, or when the file was not read at all', () => {
      const missing = `  run: MISSING since its audit (sha256 cccccccc by gamma): do not run ${step}; audit it again`;
      assert.equal(cardLines(handed, '  ', [audit], new Map([[step, null]])).at(-1), missing);
      assert.equal(cardLines(handed, '  ', [audit], NO_FILES).at(-1), missing, 'a path the map lacks is never handed as safe');
    });
  });

  it('names a gate among the owner gates and business, as configured, case aside (T1194)', () => {
    const gates = ['destructive data operations', 'budget'];
    assert.deepEqual(gateChoices(gates), ['destructive data operations', 'budget', 'business']);
    assert.equal(gateOf(' Budget ', gates), 'budget');
    assert.equal(gateOf('BUSINESS', gates), 'business');
    assert.equal(gateOf('Destructive data operations', gates), 'destructive data operations');
    assert.equal(gateOf('staffing', gates), undefined);
    assert.equal(gateOf('budg', gates), undefined);
  });
});
