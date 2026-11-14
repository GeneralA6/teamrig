import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HostPull } from '../issues/pull.ts';
import { eventsByRecipient, pullEvents, pullNewsText, pullRecipient, type PullEvent, type PullWatch } from './pull-news.ts';

const T0 = '2030-01-01T00:00:00Z';
const T1 = '2030-01-02T00:00:00Z';
const T2 = '2030-01-03T00:00:00Z';

/** An open, clean pull request of acme/web by its owner, opened and changed at T0. */
function pull(number: number, overrides: Partial<HostPull> = {}): HostPull {
  return {
    repo: 'acme/web',
    number,
    title: `Change ${number}`,
    url: `https://github.com/acme/web/pull/${number}`,
    state: 'open',
    draft: false,
    createdAt: T0,
    updatedAt: T0,
    mergedAt: undefined,
    closedAt: undefined,
    authorAssociation: 'OWNER',
    author: 'maintainer',
    head: 't1-change',
    fork: false,
    mergeable: 'mergeable',
    checks: 'passing',
    review: 'none',
    ...overrides,
  };
}

/** The watch after a read at T0 that marked `numbers` open and clean. */
function watched(...numbers: number[]): PullWatch {
  return { cursor: T0, open: numbers.map((number) => ({ number, mergeable: 'mergeable', checks: 'passing', review: 'none' })) };
}

function kinds(events: readonly PullEvent[]): string[] {
  return events.map((event) => `${event.pull.number} ${event.kind}`);
}

describe('pullEvents', () => {
  it('only marks on the first read of a repository, so its history is never news', () => {
    const merged = pull(2, { state: 'merged', updatedAt: T1, mergedAt: T1, closedAt: T1 });
    const step = pullEvents(undefined, [pull(1, { mergeable: 'conflicting', checks: 'failing' })], [merged]);
    assert.deepEqual(step, { events: [], after: { cursor: T1, open: [{ number: 1, mergeable: 'conflicting', checks: 'failing', review: 'none' }] } });
    assert.deepEqual(pullEvents(undefined, [], []).after, { cursor: undefined, open: [] });
  });

  it('tells one opened since the cursor, with a conflict or failing checks it opened with', () => {
    const fresh = pull(2, { createdAt: T1, updatedAt: T1, checks: 'failing' });
    assert.deepEqual(kinds(pullEvents(watched(1), [fresh, pull(1)], [fresh]).events), ['2 opened', '2 checks-failing']);
  });

  it('marks silently one opened before the cursor that it had no mark of, as a reopened one', () => {
    const reopened = pull(3, { updatedAt: T1, mergeable: 'conflicting' });
    const step = pullEvents(watched(1), [reopened, pull(1)], [reopened]);
    assert.deepEqual(step.events, []);
    assert.deepEqual(step.after.open.map((mark) => [mark.number, mark.mergeable]), [[3, 'conflicting'], [1, 'mergeable']]);
  });

  it('tells every one opened after a read that found no pull request at all', () => {
    assert.deepEqual(kinds(pullEvents({ cursor: undefined, open: [] }, [pull(1)], [pull(1)]).events), ['1 opened']);
  });

  it('tells a conflict, failing checks and a review state when each starts, never again while it lasts', () => {
    const turned = pull(1, { mergeable: 'conflicting', checks: 'failing', review: 'changes-requested' });
    const first = pullEvents(watched(1), [turned], []);
    assert.deepEqual(kinds(first.events), ['1 conflict', '1 checks-failing', '1 changes-requested']);
    assert.deepEqual(pullEvents(first.after, [turned], []).events, []);
    assert.deepEqual(kinds(pullEvents(first.after, [pull(1, { review: 'approved' })], []).events), ['1 approved']);
    assert.deepEqual(pullEvents(watched(1), [pull(1, { checks: 'pending', review: 'review-required' })], []).events, []);
  });

  it('keeps the last known mergeable while GitHub has not worked it out', () => {
    const conflicting = pullEvents(watched(1), [pull(1, { mergeable: 'conflicting' })], []).after;
    const unknown = pullEvents(conflicting, [pull(1, { mergeable: 'unknown' })], []);
    assert.deepEqual(unknown.events, []);
    assert.equal(unknown.after.open[0]?.mergeable, 'conflicting');
    assert.deepEqual(pullEvents(unknown.after, [pull(1, { mergeable: 'conflicting' })], []).events, []);
    assert.equal(pullEvents(undefined, [pull(1, { mergeable: 'unknown' })], []).after.open[0]?.mergeable, 'unknown');
  });

  it('tells a merge or a close of one marked open, or of one that ended after the cursor, and drops its mark', () => {
    const merged = pull(1, { state: 'merged', updatedAt: T1, mergedAt: T1, closedAt: T1 });
    const closed = pull(2, { state: 'closed', createdAt: T1, updatedAt: T2, closedAt: T2 });
    const step = pullEvents(watched(1), [pull(1)], [closed, merged, { ...merged, title: 'an older copy' }]);
    assert.deepEqual(kinds(step.events), ['2 closed', '1 merged']);
    assert.deepEqual(step.after, { cursor: T2, open: [] });
  });

  it('never tells again one that ended at the cursor, as the next read gets it once more', () => {
    const merged = pull(1, { state: 'merged', updatedAt: T1, mergedAt: T1, closedAt: T1 });
    const first = pullEvents(watched(1), [], [merged]);
    assert.deepEqual(pullEvents(first.after, [], [merged]).events, []);
    assert.equal(first.after.cursor, T1);
  });

  it('keeps the newest cursor when nothing newer was read', () => {
    assert.equal(pullEvents({ cursor: T2, open: [] }, [pull(1)], []).after.cursor, T2);
  });
});

describe('pullRecipient', () => {
  const ownerOf = (task: string): string | undefined => (task === 'T12' ? 'bravo' : undefined);

  it("routes an inside author's own branch to the owner of the task it names", () => {
    assert.equal(pullRecipient(pull(1, { head: 't12-fix' }), ownerOf, 'watch'), 'bravo');
    assert.equal(pullRecipient(pull(1, { head: 'T12', authorAssociation: 'member' }), ownerOf, 'watch'), 'bravo');
  });

  it('routes a fork, an outsider, a branch naming no task or a task the register lacks to the watcher', () => {
    for (const other of [
      pull(1, { head: 't12-fix', fork: true }),
      pull(1, { head: 't12-fix', authorAssociation: 'CONTRIBUTOR' }),
      pull(1, { head: 'feature-x' }),
      pull(1, { head: 't99-gone' }),
    ]) {
      assert.equal(pullRecipient(other, ownerOf, 'watch'), 'watch', JSON.stringify(other));
    }
  });

  it('groups the events by recipient in the order first seen', () => {
    const events: PullEvent[] = [
      { kind: 'merged', pull: pull(1, { head: 'x' }) },
      { kind: 'conflict', pull: pull(2, { head: 't12-a' }) },
      { kind: 'closed', pull: pull(3, { head: 'y' }) },
    ];
    const grouped = eventsByRecipient(events, (one) => pullRecipient(one, ownerOf, 'watch'));
    assert.deepEqual([...grouped].map(([to, list]) => [to, list.map((event) => event.pull.number)]), [['watch', [1, 3]], ['bravo', [2]]]);
  });
});

describe('pullNewsText', () => {
  it('names each pull request once with its events, its title quoted and cut', () => {
    const long = pull(2, { title: `Fix "the" ${'x'.repeat(80)}` });
    const news = pullNewsText([
      { kind: 'merged', pull: pull(1) },
      { kind: 'conflict', pull: long },
      { kind: 'checks-failing', pull: long },
    ]);
    assert.equal(news.text, `GitHub pull requests: gh:acme/web#1 "Change 1": merged; gh:acme/web#2 ${JSON.stringify(`Fix "the" ${'x'.repeat(49)}…`)}: conflicts with its base, checks failing`);
    assert.equal(news.wake, true);
  });

  it('says who opened one and from where', () => {
    const outside = pull(3, { authorAssociation: 'NONE', author: 'stranger', fork: true, draft: true });
    assert.equal(pullNewsText([{ kind: 'opened', pull: outside }]).text, 'GitHub pull requests: gh:acme/web#3 "Change 3": opened by stranger (outside, fork, draft)');
    assert.equal(pullNewsText([{ kind: 'opened', pull: pull(4, { author: '' }) }]).text, 'GitHub pull requests: gh:acme/web#4 "Change 4": opened by a deleted account');
  });

  it('wakes only for what needs a hand soon', () => {
    for (const kind of ['merged', 'closed', 'approved', 'opened'] as const) {
      assert.equal(pullNewsText([{ kind, pull: pull(1) }]).wake, false, kind);
    }
    assert.equal(pullNewsText([{ kind: 'opened', pull: pull(1, { authorAssociation: 'CONTRIBUTOR' }) }]).wake, true);
    assert.equal(pullNewsText([{ kind: 'changes-requested', pull: pull(1) }]).wake, true);
  });

  it('counts the pull requests past the ones it names', () => {
    const events = Array.from({ length: 10 }, (_, index): PullEvent => ({ kind: 'merged', pull: pull(index + 1) }));
    const text = pullNewsText(events).text;
    assert.ok(text.endsWith('gh:acme/web#8 "Change 8": merged; and 2 more'), text);
  });
});
