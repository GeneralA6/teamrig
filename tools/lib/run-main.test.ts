import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT_FINDINGS, EXIT_USAGE } from './exit.ts';
import { runMain } from './run-main.ts';

/** Runs `main` through `runMain` and keeps what it reported. */
async function runRecorded(main: () => Promise<number>): Promise<{ readonly code: number; readonly reported: readonly string[] }> {
  const reported: string[] = [];
  const code = await runMain('tool', main, (line) => reported.push(line));
  return { code, reported };
}

describe('runMain', () => {
  it("returns main's exit code and reports nothing", async () => {
    assert.deepEqual(await runRecorded(async () => EXIT_FINDINGS), { code: EXIT_FINDINGS, reported: [] });
  });

  it('reports an error by its message, prefixed with the tool name, and exits 2', async () => {
    const result = await runRecorded(async () => {
      throw new Error('Unknown option --bogus');
    });
    assert.deepEqual(result, { code: EXIT_USAGE, reported: ['tool: Unknown option --bogus'] });
  });

  it('reports a thrown value that is not an Error as its text', async () => {
    const result = await runRecorded(() => Promise.reject('disk full'));
    assert.deepEqual(result, { code: EXIT_USAGE, reported: ['tool: disk full'] });
  });
});
