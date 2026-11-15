import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeZone } from '../core/zone.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { bookedHoldReason, isBreakthrough, isCritical, quietHoldReason, type BookedQuietFacts, type QuietFacts } from './quiet.ts';

const FACTS: QuietFacts = {
  meeting: { startedAt: '2030-01-08T09:00:00.000Z', by: 'lead', endedAt: null, since: null, carried: [], kind: 'daily' },
  to: 'lead',
  lead: 'lead',
  from: 'alpha',
  leadName: 'captain',
  text: 'the build is green',
  command: 'teamrig',
  zone: TimeZone.UTC,
};

describe('the meeting quiet window', () => {
  it('knows a CRITICAL message by its first word, in any case', () => {
    assert.equal(isCritical('CRITICAL: the site is down'), true);
    assert.equal(isCritical('  critical the site is down'), true);
    assert.equal(isCritical('not CRITICAL'), false);
    assert.equal(isCritical('CRITICALLY late'), false);
  });

  it("gives the meeting's start on the team's clock", () => {
    assert.match(quietHoldReason({ ...FACTS, zone: JERUSALEM }) ?? '', /^Held: captain is in the owner's daily meeting since Tue 01-08 11:00 IST\. /);
  });

  it('holds a message to the lead during the meeting, naming the inbox line to leave instead', () => {
    assert.equal(
      quietHoldReason(FACTS),
      "Held: captain is in the owner's daily meeting since Tue 01-08 09:00 UTC. Keep working and leave this as one inbox line, which captain reads after the meeting: " +
        'teamrig inbox add --to lead --text "...". Only what needs the owner now goes as a message: start it with CRITICAL: and send it again.',
    );
    assert.ok(quietHoldReason({ ...FACTS, from: undefined }) !== undefined, 'a sender no session is known for is held too');
  });

  it('lets go a CRITICAL or empty message, the lead\'s own, one to another session, and any with no meeting', () => {
    assert.equal(quietHoldReason({ ...FACTS, text: 'CRITICAL: the site is down' }), undefined);
    assert.equal(quietHoldReason({ ...FACTS, text: '  ' }), undefined);
    assert.equal(quietHoldReason({ ...FACTS, from: 'lead' }), undefined);
    assert.equal(quietHoldReason({ ...FACTS, to: 'bravo' }), undefined);
    assert.equal(quietHoldReason({ ...FACTS, meeting: undefined }), undefined);
  });

  it("knows a break-through: a CRITICAL message to the lead in the meeting from anyone but the lead, an unknown sender too (T2524)", () => {
    const critical = { ...FACTS, text: 'CRITICAL: the site is down' };
    assert.equal(isBreakthrough(critical), true);
    assert.equal(isBreakthrough({ ...critical, from: undefined }), true);
    assert.equal(isBreakthrough(FACTS), false, 'a held message');
    assert.equal(isBreakthrough({ ...critical, from: 'lead' }), false);
    assert.equal(isBreakthrough({ ...critical, to: 'bravo' }), false);
    assert.equal(isBreakthrough({ ...critical, meeting: undefined }), false);
  });
});

const BOOKED: BookedQuietFacts = {
  meeting: {
    id: 'M4',
    at: Date.parse('2030-01-08T10:00:00.000Z'),
    minutes: 30,
    session: 'alpha',
    with: [],
    tasks: [],
    about: 'the cache design.',
    brief: null,
    status: 'started',
    notifiedAt: null,
    by: 'lead',
    changedAt: Date.parse('2030-01-08T10:05:00.000Z'),
    note: null,
  },
  to: 'alpha',
  toName: 'ace',
  from: 'bravo',
  text: 'the build is green',
  command: 'teamrig',
  zone: TimeZone.UTC,
};

describe("the quiet window of a session's own meeting (T2985)", () => {
  it('holds a message to the session met, naming the meeting, its start and the inbox line to leave instead', () => {
    assert.equal(
      bookedHoldReason(BOOKED),
      'Held: ace is in meeting M4 with the owner (the cache design) since Tue 01-08 10:05 UTC. Keep working and leave this as one inbox line, which ace reads after the meeting: ' +
        'teamrig inbox add --to alpha --text "...". Only what needs the owner now goes as a message: start it with CRITICAL: and send it again.',
    );
    assert.ok(bookedHoldReason({ ...BOOKED, from: undefined }) !== undefined, 'a sender no session is known for is held too');
  });

  it("lets go a CRITICAL or empty message, the session's own, and any with no meeting in its tab", () => {
    assert.equal(bookedHoldReason({ ...BOOKED, text: 'CRITICAL: the site is down' }), undefined);
    assert.equal(bookedHoldReason({ ...BOOKED, text: ' ' }), undefined);
    assert.equal(bookedHoldReason({ ...BOOKED, from: 'alpha' }), undefined);
    assert.equal(bookedHoldReason({ ...BOOKED, meeting: undefined }), undefined);
  });
});
