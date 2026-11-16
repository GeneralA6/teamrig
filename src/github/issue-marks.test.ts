import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LabelEvent } from '../issues/issue.ts';
import { STATUS_LABELS } from '../issues/status-push.ts';
import type { ActivityRouting } from './activity.ts';
import { issueChangeLine, issueChanges, issueMarkOf, issueMarkStep, issueRoutesBySession, type IssueAudience, type IssueMark, type MarkedIssue } from './issue-marks.ts';

const ROUTING: ActivityRouting = { ours: new Set(['octocat']), self: 'teamrig-bot' };

function issue(number: number, labels: readonly string[], state: 'open' | 'closed' = 'open', labelEvents: readonly LabelEvent[] = []): MarkedIssue {
  return { number, state, labels, labelEvents };
}

function put(label: string, actor: string, at = '2030-01-02T00:00:00Z'): LabelEvent {
  return { label, at, actor, actorKind: 'User' };
}

const OPEN_BUG: IssueMark = { open: true, labels: ['bug'] };

describe('issueMarkOf', () => {
  it("keeps open or not and the labels, sorted, once each, leaving out teamrig's own", () => {
    assert.deepEqual(issueMarkOf(issue(1, ['ui', 'bug', STATUS_LABELS['in-progress'], 'ui'], 'closed')), { open: false, labels: ['bug', 'ui'] });
  });
});

describe('issueChanges', () => {
  it('tells a close or a reopen, then each label put on and taken off, quoted', () => {
    assert.deepEqual(issueChanges(OPEN_BUG, issue(1, ['help wanted'], 'closed'), ROUTING), { state: 'closed', labels: ['labelled "help wanted"', 'unlabelled "bug"'] });
    assert.deepEqual(issueChanges({ open: false, labels: [] }, issue(1, []), ROUTING), { state: 'reopened', labels: [] });
    assert.deepEqual(issueChanges(OPEN_BUG, issue(1, ['bug', STATUS_LABELS.verifying]), ROUTING), { state: undefined, labels: [] });
  });

  it('leaves out a label one of ours or the key put on last, but not one an outsider put on after', () => {
    const events = [put('ui', 'OctoCat'), put('docs', 'teamrig-bot'), put('p1', 'octocat', '2030-01-01T00:00:00Z'), put('p1', 'visitor', '2030-01-03T00:00:00Z')];
    assert.deepEqual(issueChanges({ open: true, labels: [] }, issue(1, ['ui', 'docs', 'p1'], 'open', events), ROUTING).labels, ['labelled "p1"']);
  });
});

describe('issueMarkStep', () => {
  const audiences: ReadonlyMap<number, IssueAudience> = new Map([
    [1, { owner: { to: 'alpha', finished: false }, followers: ['charlie', 'alpha'] }],
    [2, { owner: { to: 'bravo', finished: true }, followers: [] }],
    [3, { owner: undefined, followers: ['charlie'] }],
  ]);
  const audienceOf = (number: number): IssueAudience => audiences.get(number) ?? { owner: undefined, followers: [] };

  it('marks only a watched issue, and tells nothing at its first sight', () => {
    const step = issueMarkStep('acme/web', [issue(1, ['bug']), issue(4, ['bug'])], new Map(), audienceOf, ROUTING);
    assert.deepEqual(step, { routes: [], after: new Map([[1, OPEN_BUG]]) });
  });

  it("tells the owner a close its unfinished task does not show, each follower everything, each session once", () => {
    const step = issueMarkStep('acme/web', [issue(1, ['ui'], 'closed')], new Map([[1, OPEN_BUG]]), audienceOf, ROUTING);
    assert.deepEqual(step.routes, [
      { to: 'alpha', ref: 'gh:acme/web#1', changes: ['closed', 'labelled "ui"', 'unlabelled "bug"'] },
      { to: 'charlie', ref: 'gh:acme/web#1', changes: ['closed', 'labelled "ui"', 'unlabelled "bug"'] },
    ]);
  });

  it("tells the owner of a finished task a reopen, not the close its finish made", () => {
    const closed = issueMarkStep('acme/web', [issue(2, ['bug'], 'closed')], new Map([[2, OPEN_BUG]]), audienceOf, ROUTING);
    assert.deepEqual(closed.routes, []);
    const reopened = issueMarkStep('acme/web', [issue(2, ['bug'])], new Map([[2, { open: false, labels: ['bug'] }]]), audienceOf, ROUTING);
    assert.deepEqual(reopened.routes, [{ to: 'bravo', ref: 'gh:acme/web#2', changes: ['reopened'] }]);
  });

  it('keeps the mark of a watched issue this run did not read, and drops one no longer watched', () => {
    const marks = new Map([[3, { open: false, labels: [] }], [5, OPEN_BUG]]);
    assert.deepEqual(issueMarkStep('acme/web', [], marks, audienceOf, ROUTING).after, new Map([[3, { open: false, labels: [] }]]));
  });
});

describe('issueChangeLine', () => {
  it("gives each session one line naming each issue's changes, at most eight, then how many more", () => {
    const routes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((number) => ({ to: number === 2 ? 'bravo' : 'alpha', ref: `gh:acme/web#${number}`, changes: ['closed'] }));
    const bySession = issueRoutesBySession(routes);
    assert.deepEqual([...bySession.keys()], ['alpha', 'bravo']);
    assert.equal(issueChangeLine(bySession.get('bravo') ?? []), 'GitHub issue changes: gh:acme/web#2 closed');
    assert.equal(
      issueChangeLine(bySession.get('alpha') ?? []),
      'GitHub issue changes: gh:acme/web#1 closed; gh:acme/web#3 closed; gh:acme/web#4 closed; gh:acme/web#5 closed; gh:acme/web#6 closed; gh:acme/web#7 closed; gh:acme/web#8 closed; gh:acme/web#9 closed; and 1 more',
    );
  });
});
