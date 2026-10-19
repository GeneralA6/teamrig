import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ProcessRow } from '../coordinator/memory.ts';
import { measureSessions } from './measure.ts';
import type { SessionRecord } from './record.ts';

const MB = 2 ** 20;
const TEN = Date.parse('2030-01-08T10:00:00.000Z');

const record = (claudePid: number, at: string): SessionRecord => ({ claudePid, claudeSession: `claude-${claudePid}`, at });

/** Claude Code 6900 (started 09:00) runs a shell and an MCP server; 7100 started at 11:00; 8000 runs apart. */
const ROWS: readonly ProcessRow[] = [
  { pid: 6900, parent: 1, bytes: 500 * MB, startedMs: TEN - 3_600_000 },
  { pid: 6901, parent: 6900, bytes: 200 * MB, startedMs: TEN },
  { pid: 6902, parent: 6900, bytes: 100 * MB, startedMs: TEN },
  { pid: 7100, parent: 1, bytes: 900 * MB, startedMs: TEN + 3_600_000 },
  { pid: 8000, parent: 1, bytes: 300 * MB },
];

describe('measureSessions', () => {
  it('runs a session in its recorded Claude Code, with the MB its tree holds, in record order', () => {
    const records = new Map([
      ['alpha', record(6900, '2030-01-08T10:00:00.000Z')],
      ['bravo', undefined],
      ['lead', record(4242, '2030-01-08T08:00:00.000Z')],
    ]);
    assert.deepEqual(measureSessions(records, ROWS), [
      { id: 'alpha', state: 'running', claudePid: 6900, treeMb: 800 },
      { id: 'bravo', state: 'unrecorded' },
      { id: 'lead', state: 'closed' },
    ]);
  });

  it('closes a session whose process id went to a process started after its record', () => {
    const records = new Map([['alpha', record(7100, '2030-01-08T10:00:00.000Z')]]);
    assert.deepEqual(measureSessions(records, ROWS), [{ id: 'alpha', state: 'closed' }]);
  });

  it('runs a session in a process listed with no start, as a ps list gives', () => {
    const records = new Map([['alpha', record(8000, '2030-01-08T10:00:00.000Z')]]);
    assert.deepEqual(measureSessions(records, ROWS), [{ id: 'alpha', state: 'running', claudePid: 8000, treeMb: 300 }]);
  });

  it('gives a tab to the session that recorded it last, whichever order the records come in', () => {
    const older = record(6900, '2030-01-08T10:00:00.000Z');
    const newer = record(6900, '2030-01-08T10:05:00.000Z');
    const running = { state: 'running', claudePid: 6900, treeMb: 800 };
    assert.deepEqual(
      measureSessions(
        new Map([
          ['alpha', older],
          ['bravo', newer],
        ]),
        ROWS,
      ),
      [
        { id: 'alpha', state: 'closed' },
        { id: 'bravo', ...running },
      ],
    );
    assert.deepEqual(
      measureSessions(
        new Map([
          ['bravo', newer],
          ['alpha', older],
        ]),
        ROWS,
      ),
      [
        { id: 'bravo', ...running },
        { id: 'alpha', state: 'closed' },
      ],
    );
  });
});
