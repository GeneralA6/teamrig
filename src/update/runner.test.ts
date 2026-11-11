import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeHooks } from '../testing/fake-hooks.ts';
import { APPLY_TIMEOUT_MS, applyUpdate, GIT_TIMEOUT_MS, hookGit } from './runner.ts';

describe('hookGit', () => {
  it('answers git stdout on exit 0, without the variables that redirect git and with no login prompt', async () => {
    const hooks = new FakeHooks().answer(['git', 'ls-remote', 'origin', 'HEAD'], { lines: ['abc\tHEAD', 'def\trefs/x'] });
    const git = hookGit(hooks, { PATH: '/bin', GIT_DIR: '/elsewhere' });
    assert.equal(await git.run('/repo', ['ls-remote', 'origin', 'HEAD']), 'abc\tHEAD\ndef\trefs/x');
    const [request] = hooks.ran;
    assert.equal(request?.cwd, '/repo');
    assert.equal(request?.timeoutMs, GIT_TIMEOUT_MS);
    assert.deepEqual(request?.env, { PATH: '/bin', GIT_TERMINAL_PROMPT: '0' });
  });

  it('answers undefined when git fails or is killed', async () => {
    const hooks = new FakeHooks()
      .answer(['git', 'fetch'], { end: 128 })
      .answer(['git', 'show'], { end: { kind: 'timedOut' } });
    const git = hookGit(hooks, {});
    assert.equal(await git.run('/repo', ['fetch']), undefined);
    assert.equal(await git.run('/repo', ['show']), undefined);
  });
});

describe('applyUpdate', () => {
  const claude = { command: '/bin/node', prefix: ['/lib/claude/cli.js'] };

  it('updates the marketplace, then the plugin, through Claude Code', async () => {
    const hooks = new FakeHooks();
    assert.deepEqual(await applyUpdate({ hooks, env: { PATH: '/bin' }, claude, cwd: '/home' }, 'teamrig', 'kit'), { ok: true });
    assert.deepEqual(hooks.commands, [
      '/bin/node /lib/claude/cli.js plugin marketplace update kit',
      '/bin/node /lib/claude/cli.js plugin update teamrig@kit',
    ]);
    assert.equal(hooks.ran[0]?.timeoutMs, APPLY_TIMEOUT_MS);
    assert.equal(hooks.ran[0]?.cwd, '/home');
  });

  it('stops at the first step that fails, naming it with what it printed', async () => {
    const hooks = new FakeHooks().answer(['/bin/node', '/lib/claude/cli.js', 'plugin', 'marketplace', 'update', 'kit'], { lines: ['network down '], end: 1 });
    assert.deepEqual(await applyUpdate({ hooks, env: {}, claude, cwd: '/home' }, 'teamrig', 'kit'), {
      ok: false,
      step: 'claude plugin marketplace update kit',
      said: 'network down',
    });
    assert.equal(hooks.ran.length, 1);
  });
});
