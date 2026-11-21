import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testHostIssue } from '../testing/host-issue.ts';
import { TimeZone } from '../core/zone.ts';
import { fieldPaths } from '../testing/field-paths.ts';
import {
  ANSWER_TARGET_HOURS,
  CLOCK_STATE_FORMAT,
  formatClocks,
  isLate,
  issueThread,
  lateGroupText,
  lateText,
  leadTurnAt,
  ownerFirstOf,
  postIsOurs,
  parseClocks,
  remindersText,
  reminderText,
  REMIND_SHARE,
  stepClocks,
  toldsText,
  toldText,
  waitingSince,
  type Clock,
  type OwnerFirst,
  type Thread,
  type ThreadPost,
} from './clock.ts';

const HOUR = 3_600_000;
/** alpha is a session of the team, told GH-LATE before the lead. */
const ALPHA_FIRST: OwnerFirst = (owner) => owner === 'alpha';
const NOBODY_FIRST: OwnerFirst = () => false;
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
    const step = stepClocks(new Map(), read, [thread(1, [outside(0)]), thread(2, [outside(0), ours(1)])], T0 + HOUR, ALPHA_FIRST);
    assert.deepEqual([...step.clocks.keys()], ['acme/app#1']);
    assert.deepEqual(step.clocks.get('acme/app#1'), { repo: 'acme/app', ref: 'acme/app#1', kind: 'bug', owner: 'alpha', since: T0, remindedAt: undefined, toldAt: undefined });
    assert.deepEqual(step.remind, []);
  });

  it('reminds once at 75% of the target, and keeps the reminder while the same wait runs', () => {
    const at = T0 + 18 * HOUR;
    const first = stepClocks(new Map(), read, [thread(1, [outside(0)])], at, ALPHA_FIRST);
    assert.deepEqual(first.remind.map((clock) => clock.ref), ['acme/app#1']);
    assert.equal(first.clocks.get('acme/app#1')?.remindedAt, at);
    const second = stepClocks(first.clocks, read, [thread(1, [outside(0), outside(19)])], at + HOUR, ALPHA_FIRST);
    assert.deepEqual(second.remind, []);
    assert.equal(second.clocks.get('acme/app#1')?.remindedAt, at);
  });

  it('does not remind before 75%', () => {
    assert.deepEqual(stepClocks(new Map(), read, [thread(1, [outside(0)])], T0 + 18 * HOUR - 1, ALPHA_FIRST).remind, []);
  });

  it('tells a session owner GH-LATE once at the target, keeps it while the same wait runs, and tells again for a fresh wait (#1507)', () => {
    const before = stepClocks(new Map(), read, [thread(1, [outside(0)])], T0 + 18 * HOUR, ALPHA_FIRST).clocks;
    assert.deepEqual(stepClocks(before, read, [thread(1, [outside(0)])], T0 + 24 * HOUR - 1, ALPHA_FIRST).tell, []);
    const late = stepClocks(before, read, [thread(1, [outside(0)])], T0 + 24 * HOUR, ALPHA_FIRST);
    assert.deepEqual(late.tell.map((clock) => clock.ref), ['acme/app#1']);
    assert.equal(late.clocks.get('acme/app#1')?.toldAt, T0 + 24 * HOUR);
    const again = stepClocks(late.clocks, read, [thread(1, [outside(0), outside(25)])], T0 + 26 * HOUR, ALPHA_FIRST);
    assert.deepEqual(again.tell, []);
    assert.equal(again.clocks.get('acme/app#1')?.toldAt, T0 + 24 * HOUR);
    const fresh = stepClocks(late.clocks, read, [thread(1, [outside(0), ours(27), outside(28)])], T0 + 52 * HOUR, ALPHA_FIRST);
    assert.deepEqual(fresh.tell.map((clock) => clock.toldAt), [T0 + 52 * HOUR]);
  });

  it('tells GH-LATE alone, no reminder too, to an owner first read past its target', () => {
    const step = stepClocks(new Map(), read, [thread(1, [outside(0)])], T0 + 30 * HOUR, ALPHA_FIRST);
    assert.deepEqual([step.remind.length, step.tell.length], [0, 1]);
  });

  it('tells nothing to an owner the lead is told about first: off the team, or the lead itself', () => {
    const step = stepClocks(new Map(), read, [thread(1, [outside(0)])], T0 + 30 * HOUR, NOBODY_FIRST);
    assert.deepEqual(step.tell, []);
    assert.equal(step.clocks.get('acme/app#1')?.toldAt, undefined);
  });

  it('starts afresh, reminder and told time cleared, once we answered and the outsider posts again', () => {
    const before: ReadonlyMap<string, Clock> = new Map([['acme/app#1', { repo: 'acme/app', ref: 'acme/app#1', kind: 'bug', owner: 'alpha', since: T0, remindedAt: T0 + 18 * HOUR, toldAt: T0 + 24 * HOUR }]]);
    const step = stepClocks(before, read, [thread(1, [outside(0), ours(20), outside(21)])], T0 + 22 * HOUR, ALPHA_FIRST);
    assert.deepEqual(step.clocks.get('acme/app#1'), { repo: 'acme/app', ref: 'acme/app#1', kind: 'bug', owner: 'alpha', since: T0 + 21 * HOUR, remindedAt: undefined, toldAt: undefined });
  });

  it('tells a new owner who takes the thread over mid-wait afresh, as the old owner was the one told', () => {
    const before: ReadonlyMap<string, Clock> = new Map([['acme/app#1', { repo: 'acme/app', ref: 'acme/app#1', kind: 'bug', owner: 'bravo', since: T0, remindedAt: T0 + 18 * HOUR, toldAt: T0 + 24 * HOUR }]]);
    const step = stepClocks(before, read, [thread(1, [outside(0)])], T0 + 30 * HOUR, ALPHA_FIRST);
    assert.deepEqual(step.tell.map((clock) => [clock.owner, clock.toldAt]), [['alpha', T0 + 30 * HOUR]]);
    assert.equal(step.clocks.get('acme/app#1')?.since, T0);
  });

  it('stops the clock of a thread answered, closed or gone from a repository read, and keeps those of one not read', () => {
    const clock = (ref: string): Clock => ({ repo: ref.slice(0, ref.indexOf('#')), ref, kind: 'bug', owner: 'alpha', since: T0, remindedAt: undefined, toldAt: undefined });
    const before = new Map([['acme/app#1', clock('acme/app#1')], ['acme/app#2', clock('acme/app#2')], ['acme/docs#3', clock('acme/docs#3')]]);
    const step = stepClocks(before, read, [thread(1, [outside(0), ours(1)])], T0 + 2 * HOUR, ALPHA_FIRST);
    assert.deepEqual([...step.clocks.keys()], ['acme/docs#3']);
  });
});

describe("the lead's turn (#1507)", () => {
  const clock = (kind: Thread['kind'], toldAt: number | undefined, owner = 'alpha'): Clock => ({ repo: 'a', ref: 'a#1', kind, owner, since: T0, remindedAt: undefined, toldAt });

  it('comes a second window after the owner was told, as long as the target and at most 24 h', () => {
    assert.equal(leadTurnAt(clock('security', T0 + 4 * HOUR), ALPHA_FIRST), T0 + 8 * HOUR);
    assert.equal(leadTurnAt(clock('bug', T0 + 24 * HOUR), ALPHA_FIRST), T0 + 48 * HOUR);
    assert.equal(leadTurnAt(clock('feature', T0 + 72 * HOUR), ALPHA_FIRST), T0 + 96 * HOUR);
  });

  it('counts the window from when the owner was told, so a late sync gives the owner the whole window', () => {
    assert.equal(leadTurnAt(clock('bug', T0 + 30 * HOUR), ALPHA_FIRST), T0 + 54 * HOUR);
  });

  it('counts it from the target while the owner is not told yet, a clock of format 1 too', () => {
    assert.equal(leadTurnAt(clock('bug', undefined), ALPHA_FIRST), T0 + 48 * HOUR);
  });

  it('comes at the target when the owner is no session told first', () => {
    assert.equal(leadTurnAt(clock('bug', undefined, 'web'), ALPHA_FIRST), T0 + 24 * HOUR);
    assert.equal(leadTurnAt(clock('security', undefined, 'alpha'), NOBODY_FIRST), T0 + 4 * HOUR);
  });

  it("tells first every session of the team but the lead", () => {
    const first = ownerFirstOf(['lead', 'alpha', 'bravo'], 'lead');
    assert.deepEqual(['lead', 'alpha', 'bravo', 'web'].map(first), [false, true, true, false]);
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
      ['a#1', { repo: 'a', ref: 'a#1', kind: 'security', owner: 'alpha', since: T0, remindedAt: T0 + HOUR, toldAt: T0 + 4 * HOUR }],
      ['a#2', { repo: 'a', ref: 'a#2', kind: 'feature', owner: 'bravo', since: T0, remindedAt: undefined, toldAt: undefined }],
    ]);
    assert.deepEqual(parseClocks(formatClocks(clocks)), clocks);
    assert.equal(parseClocks('not json').size, 0);
    assert.equal(parseClocks('{"v":3,"clocks":[{"repo":"a","ref":"a#2","kind":"bug","owner":"x","since":1}]}').size, 0);
    assert.deepEqual([...parseClocks('{"v":2,"clocks":[{"repo":"a","ref":"a#1","kind":"urgent","owner":"x","since":1},{"repo":"a","ref":"a#2","kind":"bug","owner":"x","since":1}]}').keys()], ['a#2']);
  });

  it('writes the pinned fields of its format: a field added to the file raises CLOCK_STATE_FORMAT (#1507)', () => {
    const full = new Map<string, Clock>([['a#1', { repo: 'a', ref: 'a#1', kind: 'bug', owner: 'alpha', since: T0, remindedAt: T0 + HOUR, toldAt: T0 + 2 * HOUR }]]);
    assert.equal(CLOCK_STATE_FORMAT, 2);
    assert.deepEqual(fieldPaths(JSON.parse(formatClocks(full))), ['clocks[].kind', 'clocks[].owner', 'clocks[].ref', 'clocks[].remindedAt', 'clocks[].repo', 'clocks[].since', 'clocks[].toldAt', 'v']);
  });

  it('reads format 1, which kept no told time', () => {
    const clock = parseClocks('{"v":1,"clocks":[{"repo":"a","ref":"a#1","kind":"bug","owner":"x","since":1,"remindedAt":2}]}').get('a#1');
    assert.deepEqual(clock, { repo: 'a', ref: 'a#1', kind: 'bug', owner: 'x', since: 1, remindedAt: 2, toldAt: undefined });
  });
});

describe('the texts', () => {
  const zone = TimeZone.UTC;
  const clock: Clock = { repo: 'acme/web', ref: 'gh:acme/web#9', kind: 'bug', owner: 'alpha', since: T0, remindedAt: undefined, toldAt: undefined };

  it("words the owner's reminder and the lead's GH-LATE line, times zone-marked", () => {
    assert.equal(
      reminderText(clock, T0 + 18 * HOUR, zone, NOBODY_FIRST),
      'GitHub gh:acme/web#9 (bug) has waited 18 h for an answer of ours, since 11-15 08:00 UTC; answer it in words on GitHub by 11-16 08:00 UTC, its 24 h target, or GH-LATE goes to the lead',
    );
    assert.equal(
      reminderText(clock, T0 + 18 * HOUR, zone, ALPHA_FIRST),
      'GitHub gh:acme/web#9 (bug) has waited 18 h for an answer of ours, since 11-15 08:00 UTC; answer it in words on GitHub by 11-16 08:00 UTC, its 24 h target, or GH-LATE goes to you, and to the lead from 11-17 08:00 UTC',
    );
    assert.equal(
      toldText({ ...clock, toldAt: T0 + 24 * HOUR }, T0 + 24 * HOUR, zone, ALPHA_FIRST),
      'GH-LATE gh:acme/web#9 (bug) has waited 24 h for an answer of ours since 11-15 08:00 UTC, past its 24 h target: answer it in words on GitHub by 11-17 08:00 UTC, or it goes to the lead',
    );
    assert.equal(
      lateText({ ...clock, toldAt: T0 + 24 * HOUR }, T0 + 48 * HOUR, zone),
      'GH-LATE gh:acme/web#9 (bug, alpha) has waited 48 h for an answer of ours since 11-15 08:00 UTC, past its 24 h target; alpha was told at 11-16 08:00 UTC: have alpha answer it on GitHub',
    );
    assert.equal(
      lateText(clock, T0 + 25 * HOUR, zone),
      'GH-LATE gh:acme/web#9 (bug, alpha) has waited 25 h for an answer of ours since 11-15 08:00 UTC, past its 24 h target: have alpha answer it on GitHub',
    );
  });

  it('words one thread as its own line, and several as one line with the count and the first few refs (#1475)', () => {
    const at = (n: number, since: number, kind: Clock['kind'] = 'bug', owner = 'alpha'): Clock => ({ ...clock, ref: `gh:acme/web#${n}`, since, kind, owner });
    assert.equal(remindersText([clock], T0 + 18 * HOUR, zone, ALPHA_FIRST), reminderText(clock, T0 + 18 * HOUR, zone, ALPHA_FIRST));
    assert.equal(toldsText([clock], T0 + 24 * HOUR, zone, ALPHA_FIRST), toldText(clock, T0 + 24 * HOUR, zone, ALPHA_FIRST));
    assert.equal(lateGroupText([clock], T0 + 25 * HOUR, zone), lateText(clock, T0 + 25 * HOUR, zone));
    // Due first leads the reminder: the security thread's 4 h target falls before the older bug's 24 h one.
    const due = [at(1, T0), at(2, T0 + HOUR), at(3, T0 + 15 * HOUR, 'security'), at(4, T0 + 2 * HOUR), at(5, T0 + 3 * HOUR, 'feature')];
    assert.equal(
      remindersText(due, T0 + 18 * HOUR, zone, NOBODY_FIRST),
      '5 GitHub threads wait for an answer of ours: gh:acme/web#3 (security, by 11-16 03:00 UTC), gh:acme/web#1 (bug, by 11-16 08:00 UTC), gh:acme/web#2 (bug, by 11-16 09:00 UTC) and 2 more; answer each in words on GitHub by its target, or GH-LATE goes to the lead',
    );
    assert.match(remindersText(due, T0 + 18 * HOUR, zone, ALPHA_FIRST), /; answer each in words on GitHub by its target, or GH-LATE goes to you, and to the lead a second window later$/);
    // Told first by when each goes to the lead (#1507): the security thread's 4 h window ends before the bugs' 24 h ones.
    const told = [at(1, T0), at(3, T0 + 15 * HOUR, 'security'), at(2, T0 + HOUR)].map((late) => ({ ...late, toldAt: T0 + 24 * HOUR }));
    assert.equal(
      toldsText(told, T0 + 24 * HOUR, zone, ALPHA_FIRST),
      'GH-LATE 3 GitHub threads waited past their answer target for an answer of ours: gh:acme/web#3 (security, by 11-16 12:00 UTC), gh:acme/web#1 (bug, by 11-17 08:00 UTC), gh:acme/web#2 (bug, by 11-17 08:00 UTC); answer each in words on GitHub by then, or it goes to the lead',
    );
    const late = [at(7, T0 + HOUR, 'bug', 'bravo'), at(6, T0), at(8, T0 + 2 * HOUR)];
    assert.equal(
      lateGroupText(late, T0 + 30 * HOUR, zone),
      'GH-LATE 3 GitHub threads waited past their answer target for an answer of ours, oldest first: gh:acme/web#6 (bug, alpha, 30 h), gh:acme/web#7 (bug, bravo, 29 h), gh:acme/web#8 (bug, alpha, 28 h): have their owners answer them on GitHub',
    );
  });
});
