import { TimeZone } from '../core/zone.ts';

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
