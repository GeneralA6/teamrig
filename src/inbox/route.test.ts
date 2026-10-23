import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LeadTree } from '../config/lead-tree.ts';
import { routeReminderOf } from './route.ts';

/** lead over bravo and echo; bravo over charlie; charlie over delta. */
const TREE = new LeadTree({
  sessions: ['lead', 'bravo', 'charlie', 'delta', 'echo'],
  roles: { lead: 'lead' },
  leads: { bravo: ['charlie'], charlie: ['delta'] },
});

const named = (id: string): string => `app-${id}`;

function reminder(from: string, to: string, text = 'take T1'): string | undefined {
  return routeReminderOf(TREE, { from, to, text }, named, 'teamrig');
}

describe('routeReminderOf', () => {
  it('tells a sender that skipped a sub-lead to route via it, naming sessions as the sender addresses them', () => {
    assert.equal(
      reminder('lead', 'charlie'),
      'teamrig: app-charlie works under app-bravo: route such work via app-bravo next time; an urgent incident (a message starting CRITICAL) stays direct.',
    );
  });

  it('names the sub-lead right below the sender when the message skips several', () => {
    assert.match(reminder('lead', 'delta') ?? '', /^teamrig: app-delta works under app-bravo: route such work via app-bravo next time;/);
    assert.match(reminder('bravo', 'delta') ?? '', /^teamrig: app-delta works under app-charlie: route such work via app-charlie next time;/);
  });

  it('leaves an urgent incident direct, in any case, and an empty message alone', () => {
    assert.equal(reminder('lead', 'charlie', 'CRITICAL: the nightly run is down'), undefined);
    assert.equal(reminder('lead', 'charlie', '  critical incident, look now'), undefined);
    assert.equal(reminder('lead', 'charlie', '  '), undefined);
  });

  it('says nothing for a direct leader, a message up or across, or an id off the team', () => {
    assert.equal(reminder('charlie', 'delta'), undefined);
    assert.equal(reminder('lead', 'echo'), undefined);
    assert.equal(reminder('delta', 'lead'), undefined);
    assert.equal(reminder('echo', 'delta'), undefined);
    assert.equal(reminder('lead', 'zulu'), undefined);
  });
});
