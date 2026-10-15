import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HintLog } from './hint-log.ts';
import { REQUIREMENTS_HINT, requirementsNoteOnce, type RequirementsNoteInput } from './requirements-note.ts';

const SESSION = '0123abcd-0000-4000-8000-00000000000a';
const NOW = new Date('2030-01-08T10:00:00Z');

/** A hint log in memory that counts its reads. */
class CountingLog implements HintLog {
  readonly given: string[] = [];
  reads = 0;

  async shown(claudeSession: string, reason: string): Promise<boolean> {
    this.reads += 1;
    return this.given.includes(`${claudeSession}:${reason}`);
  }

  async record(claudeSession: string, reason: string): Promise<void> {
    this.given.push(`${claudeSession}:${reason}`);
  }
}

function note(log: HintLog, overrides: Partial<RequirementsNoteInput> = {}): Promise<string | undefined> {
  return requirementsNoteOnce({ problems: [{ kind: 'git-missing' }], log, claudeSession: SESSION, now: NOW, command: 'teamrig', ...overrides });
}

describe('requirementsNoteOnce', () => {
  it('gives the note once per Claude Code session, recorded under its own reason', async () => {
    const log = new CountingLog();
    assert.match((await note(log)) ?? '', /^git is not installed/);
    assert.equal(await note(log), undefined);
    assert.deepEqual(log.given, [`${SESSION}:${REQUIREMENTS_HINT}`]);
  });

  it('puts each problem on its own line', async () => {
    const text = await note(new CountingLog(), { problems: [{ kind: 'git-missing' }, { kind: 'node-old', running: '20.0.0' }] });
    assert.equal(text?.split('\n').length, 2);
  });

  it('reads no log when nothing is missing', async () => {
    const log = new CountingLog();
    assert.equal(await note(log, { problems: [] }), undefined);
    assert.equal(log.reads, 0);
  });

  it('gives the note every time when the payload named no session', async () => {
    const log = new CountingLog();
    assert.ok((await note(log, { claudeSession: null })) !== undefined);
    assert.ok((await note(log, { claudeSession: null })) !== undefined);
    assert.equal(log.reads, 0);
  });
});
