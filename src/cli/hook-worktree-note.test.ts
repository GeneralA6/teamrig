import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { WORKTREE_NOTE } from '../hooks/worktree-note.ts';
import { APP, CLAUDE_SESSION, CliHarness, contextOf, type RunOptions } from '../testing/cli-harness.ts';
import { NO_PATHS_HOST } from '../testing/host.ts';

/** The SessionStart context of session alpha starting in `cwd`, on the host `options` name (the shipped one unless they do). */
async function startIn(cwd: string, options: Pick<RunOptions, 'host'> = {}): Promise<string> {
  const kit = new CliHarness();
  const stdin = JSON.stringify({ session_id: CLAUDE_SESSION, cwd, source: 'startup' });
  return contextOf(await kit.run(['hook', 'session-start'], { ...options, stdin, env: { TEAMRIG_SESSION: 'alpha' } }));
}

describe('the SessionStart hook in a Claude Code worktree', () => {
  it('tells a session started in a Claude Code worktree which shell forms the isolation refuses', async () => {
    assert.ok((await startIn(join(APP, '.claude', 'worktrees', 'fix-1'))).includes(`\n${WORKTREE_NOTE}`));
  });

  it('says nothing of it in the project folder', async () => {
    assert.ok(!(await startIn(APP)).includes(WORKTREE_NOTE));
  });

  it('says nothing of it on a host whose folders teamrig does not know, and still gives the session its start', async () => {
    const context = await startIn(join(APP, '.claude', 'worktrees', 'fix-1'), { host: NO_PATHS_HOST });
    assert.ok(!context.includes(WORKTREE_NOTE));
    assert.match(context, /You are the `alpha` session/);
  });
});
