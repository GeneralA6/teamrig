import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { WORKTREE_NOTE } from '../hooks/worktree-note.ts';
import { APP, CLAUDE_SESSION, CliHarness, contextOf } from '../testing/cli-harness.ts';

/** The SessionStart context of session alpha starting in `cwd`. */
async function startIn(cwd: string): Promise<string> {
  const kit = new CliHarness();
  const stdin = JSON.stringify({ session_id: CLAUDE_SESSION, cwd, source: 'startup' });
  return contextOf(await kit.run(['hook', 'session-start'], { stdin, env: { TEAMRIG_SESSION: 'alpha' } }));
}

describe('the SessionStart hook in a Claude Code worktree', () => {
  it('tells a session started in a Claude Code worktree which shell forms the isolation refuses', async () => {
    assert.ok((await startIn(join(APP, '.claude', 'worktrees', 'fix-1'))).includes(`\n${WORKTREE_NOTE}`));
  });

  it('says nothing of it in the project folder', async () => {
    assert.ok(!(await startIn(APP)).includes(WORKTREE_NOTE));
  });
});
