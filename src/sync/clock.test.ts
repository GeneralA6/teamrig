import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testHostIssue } from '../testing/host-issue.ts';
import { TimeZone } from '../core/zone.ts';
import { ANSWER_TARGET_HOURS, formatClocks, isLate, issueThread, lateGroupText, lateText, postIsOurs, parseClocks, remindersText, reminderText, REMIND_SHARE, stepClocks, waitingSince, type Clock, type Thread, type ThreadPost } from './clock.ts';

const HOUR = 3_600_000;
/** A team whose `github.owners` names no login: a post is ours by its tie to the repository. */
const NO_ONE: ReadonlySet<string> = new Set();
const T0 = Date.UTC(2026, 10, 15, 8);
const outside = (hours: number): ThreadPost => ({ at: T0 + hours * HOUR, ours: false });
const ours = (hours: number): ThreadPost => ({ at: T0 + hours * HOUR, ours: true });
const thread = (number: number, posts: readonly ThreadPost[], kind: Thread['kind'] = 'bug'): Thread => ({ repo: 'acme/app', ref: `acme/app#${number}`, kind, owner: 'alpha', posts });

describe('waitingSince', () => {
  it('starts at the oldest outside post after our newest one, so a follow-up does not restart the wait', () => {
    assert.equal(waitingSince([outside(0), ours(1), outside(2), outside(5)]), T0 + 2 * HOUR);
  });

  it('is undefined when we spoke last, or only we posted', () => {
    assert.equal(waitingSince([outside(0), ours(1)]), undefined);
    assert.equal(waitingSince([ours(0)]), undefined);
    assert.equal(waitingSince([]), undefined);
  });

  it('reads posts in time order whatever order they come in', () => {
    assert.equal(waitingSince([outside(5), ours(1), outside(0), outside(2)]), T0 + 2 * HOUR);
  });
});

describe('the answer targets', () => {
  it('pins the design table: security 4 h, bug, pull and comment 24 h, feature 72 h; reminded at 75%', () => {
    assert.deepEqual(ANSWER_TARGET_HOURS, { security: 4, bug: 24, pull: 24, comment: 24, feature: 72 });
    assert.equal(REMIND_SHARE, 0.75);
  });

  it('is late at its target, not before', () => {
    assert.equal(isLate({ kind: 'security', since: T0 }, T0 + 4 * HOUR - 1), false);
    assert.equal(isLate({ kind: 'security', since: T0 }, T0 + 4 * HOUR), true);
  });
});

describe('stepClocks', () => {
  const read = new Set(['acme/app']);

  it('starts a clock on a thread waiting on us, and none on one we answered', () => {
    const step = stepClocks(new Map(), read, [thread(1, [outside(0)]), thread(2, [outside(0), ours(1)])], T0 + HOUR);
    assert.deepEqual([...step.clocks.keys()], ['acme/app#1']);
    assert.deepEqual(step.clocks.get('acme/app#1'), { repo: 'acme/app', ref: 'acme/app#1', kind: 'bug', owner: 'alpha', since: T0, remindedAt: undefined });
    assert.deepEqual(step.remind, []);
  });

  it('reminds once at 75% of the target, and keeps the reminder while the same wait runs', () => {
    const at = T0 + 18 * HOUR;
    const first = stepClocks(new Map(), read, [thread(1, [outside(0)])], at);
    assert.deepEqual(first.remind.map((clock) => clock.ref), ['acme/app#1']);
    assert.equal(first.clocks.get('acme/app#1')?.remindedAt, at);
    const second = stepClocks(first.clocks, read, [thread(1, [outside(0), outside(19)])], at + HOUR);
    assert.deepEqual(second.remind, []);
    assert.equal(second.clocks.get('acme/app#1')?.remindedAt, at);
  });

  it('does not remind before 75%', () => {
    assert.deepEqual(stepClocks(new Map(), read, [thread(1, [outside(0)])], T0 + 18 * HOUR - 1).remind, []);
  });

  it('starts afresh, reminder cleared, once we answered and the outsider posts again', () => {
    const before: ReadonlyMap<string, Clock> = new Map([['acme/app#1', { repo: 'acme/app', ref: 'acme/app#1', kind: 'bug', owner: 'alpha', since: T0, remindedAt: T0 + 18 * HOUR }]]);
    const step = stepClocks(before, read, [thread(1, [outside(0), ours(20), outside(21)])], T0 + 22 * HOUR);
    assert.deepEqual(step.clocks.get('acme/app#1'), { repo: 'acme/app', ref: 'acme/app#1', kind: 'bug', owner: 'alpha', since: T0 + 21 * HOUR, remindedAt: undefined });
  });

  it('stops the clock of a thread answered, closed or gone from a repository read, and keeps those of one not read', () => {
    const clock = (ref: string): Clock => ({ repo: ref.slice(0, ref.indexOf('#')), ref, kind: 'bug', owner: 'alpha', since: T0, remindedAt: undefined });
    const before = new Map([['acme/app#1', clock('acme/app#1')], ['acme/app#2', clock('acme/app#2')], ['acme/docs#3', clock('acme/docs#3')]]);
    const step = stepClocks(before, read, [thread(1, [outside(0), ours(1)])], T0 + 2 * HOUR);
    assert.deepEqual([...step.clocks.keys()], ['acme/docs#3']);
  });
});

describe('issueThread', () => {
  const at = (hours: number): string => new Date(T0 + hours * HOUR).toISOString();

  it('reads the opening post and the comments, ours by tie, a bot left out', () => {
    const issue = testHostIssue(4, {
      authorAssociation: 'NONE',
      createdAt: at(0),
      comments: [
        { at: at(1), login: 'maintainer', authorAssociation: 'MEMBER', authorKind: 'User' },
        { at: at(2), login: 'ci-bot', authorAssociation: 'NONE', authorKind: 'Bot' },
        { at: at(3), login: 'ada', authorAssociation: 'CONTRIBUTOR', authorKind: 'User' },
      ],
    });
    assert.deepEqual(issueThread(issue, 'gh:acme/web#4', 'alpha', false, NO_ONE), {
      repo: 'acme/web',
      ref: 'gh:acme/web#4',
      kind: 'feature',
      owner: 'alpha',
      posts: [
        { at: T0, ours: false },
        { at: T0 + HOUR, ours: true },
        { at: T0 + 3 * HOUR, ours: false },
      ],
    });
  });

  it('names the kind by label, security before bug, else comment on a held thread, else feature', () => {
    const kind = (labels: readonly string[], held: boolean): string | undefined => issueThread(testHostIssue(1, { labels }), 'r', 'alpha', held, NO_ONE)?.kind;
    assert.equal(kind(['Bug', 'Security'], false), 'security');
    assert.equal(kind(['BUG'], true), 'bug');
    assert.equal(kind([], true), 'comment');
    assert.equal(kind(['enhancement'], false), 'feature');
  });

  it('gives no thread for a closed issue', () => {
    assert.equal(issueThread(testHostIssue(1, { state: 'closed' }), 'r', 'alpha', false, NO_ONE), undefined);
  });

  it("reads a post as ours by the team's logins when it names any, so an outside collaborator still waits on us (T3380)", () => {
    const issue = testHostIssue(4, {
      authorAssociation: 'COLLABORATOR',
      author: 'contrib',
      createdAt: at(0),
      comments: [
        { at: at(1), login: 'contrib', authorAssociation: 'COLLABORATOR', authorKind: 'User' },
        { at: at(2), login: 'OctoCat', authorAssociation: 'MEMBER', authorKind: 'User' },
      ],
    });
    assert.deepEqual(
      issueThread(issue, 'r', 'alpha', false, new Set(['octocat']))?.posts.map((post) => post.ours),
      [false, false, true],
    );
  });
});

describe('postIsOurs (T3380)', () => {
  const TEAM_LOGINS = new Set(['octocat']);

  it("counts the team's logins, whatever their case, and the repository's owner, and no other tie", () => {
    assert.equal(postIsOurs('NONE', 'OctoCat', TEAM_LOGINS), true);
    assert.equal(postIsOurs('OWNER', 'acme', TEAM_LOGINS), true);
    assert.equal(postIsOurs('COLLABORATOR', 'contrib', TEAM_LOGINS), false);
    assert.equal(postIsOurs('MEMBER', '', TEAM_LOGINS), false);
  });

  it('falls back to the tie to the repository when the team names no login', () => {
    assert.equal(postIsOurs('COLLABORATOR', 'contrib', NO_ONE), true);
    assert.equal(postIsOurs('CONTRIBUTOR', 'ada', NO_ONE), false);
  });
});

describe('the clocks file', () => {
  it('reads back what it wrote, a reminder time too, and reads a damaged file or entry as none', () => {
    const clocks = new Map<string, Clock>([
      ['a#1', { repo: 'a', ref: 'a#1', kind: 'security', owner: 'alpha', since: T0, remindedAt: T0 + HOUR }],
      ['a#2', { repo: 'a', ref: 'a#2', kind: 'feature', owner: 'bravo', since: T0, remindedAt: undefined }],
    ]);
    assert.deepEqual(parseClocks(formatClocks(clocks)), clocks);
    assert.equal(parseClocks('not json').size, 0);
    assert.equal(parseClocks('{"v":2,"clocks":[]}').size, 0);
    assert.deepEqual([...parseClocks('{"v":1,"clocks":[{"repo":"a","ref":"a#1","kind":"urgent","owner":"x","since":1},{"repo":"a","ref":"a#2","kind":"bug","owner":"x","since":1}]}').keys()], ['a#2']);
  });
});

describe('the texts', () => {
  const zone = TimeZone.UTC;
  const clock: Clock = { repo: 'acme/web', ref: 'gh:acme/web#9', kind: 'bug', owner: 'alpha', since: T0, remindedAt: undefined };

  it("words the owner's reminder and the lead's GH-LATE line, times zone-marked", () => {
    assert.equal(
      reminderText(clock, T0 + 18 * HOUR, zone),
      'GitHub gh:acme/web#9 (bug) has waited 18 h for an answer of ours, since 11-15 08:00 UTC; answer it in words on GitHub by 11-16 08:00 UTC, its 24 h target, or GH-LATE goes to the lead',
    );
    assert.equal(
      lateText(clock, T0 + 25 * HOUR, zone),
      'GH-LATE gh:acme/web#9 (bug, alpha) has waited 25 h for an answer of ours since 11-15 08:00 UTC, past its 24 h target: have alpha answer it on GitHub',
    );
  });

  it('words one thread as its own line, and several as one line with the count and the first few refs (#1475)', () => {
    const at = (n: number, since: number, kind: Clock['kind'] = 'bug', owner = 'alpha'): Clock => ({ ...clock, ref: `gh:acme/web#${n}`, since, kind, owner });
    assert.equal(remindersText([clock], T0 + 18 * HOUR, zone), reminderText(clock, T0 + 18 * HOUR, zone));
    assert.equal(lateGroupText([clock], T0 + 25 * HOUR, zone), lateText(clock, T0 + 25 * HOUR, zone));
    // Due first leads the reminder: the security thread's 4 h target falls before the older bug's 24 h one.
    const due = [at(1, T0), at(2, T0 + HOUR), at(3, T0 + 15 * HOUR, 'security'), at(4, T0 + 2 * HOUR), at(5, T0 + 3 * HOUR, 'feature')];
    assert.equal(
      remindersText(due, T0 + 18 * HOUR, zone),
      '5 GitHub threads wait for an answer of ours: gh:acme/web#3 (security, by 11-16 03:00 UTC), gh:acme/web#1 (bug, by 11-16 08:00 UTC), gh:acme/web#2 (bug, by 11-16 09:00 UTC) and 2 more; answer each in words on GitHub by its target, or GH-LATE goes to the lead',
    );
    const late = [at(7, T0 + HOUR, 'bug', 'bravo'), at(6, T0), at(8, T0 + 2 * HOUR)];
    assert.equal(
      lateGroupText(late, T0 + 30 * HOUR, zone),
      'GH-LATE 3 GitHub threads waited past their answer target for an answer of ours, oldest first: gh:acme/web#6 (bug, alpha, 30 h), gh:acme/web#7 (bug, bravo, 29 h), gh:acme/web#8 (bug, alpha, 28 h): have their owners answer them on GitHub',
    );
  });
});
