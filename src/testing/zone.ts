import { TimeZone } from '../core/zone.ts';
import type { RulesClock } from '../rules/pack.ts';

/** A zone a test names: one the runtime's time zone data lacks fails the test, never falls back to UTC. */
export function testZone(name: string): TimeZone {
  const zone = TimeZone.of(name);
  if (zone === undefined) {
    throw new Error(`no time zone ${name} in this runtime's time zone data`);
  }
  return zone;
}

/** A zone with daylight saving time, IST in winter and IDT in summer: a test sees a stored minute and a bare day move off UTC. */
export const JERUSALEM: TimeZone = testZone('Asia/Jerusalem');

/** The harness's moment, 2030-01-08 10:00 UTC, on a machine on UTC: rules read with it name the queue cutoff in UTC. */
export const RULES_CLOCK: RulesClock = { now: new Date('2030-01-08T10:00:00.000Z'), machineZone: 'UTC' };
