import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type PluginTestDeps, isolatedEnv, realPluginTestDeps, runPluginTests } from './plugin-test.ts';

function fakeDeps(status: number | null | Error): { deps: PluginTestDeps; calls: { file: string; args: readonly string[]; env: NodeJS.ProcessEnv }[]; made: string[]; removed: string[]; err: string[] } {
  const calls: { file: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  const made: string[] = [];
  const removed: string[] = [];
  const err: string[] = [];
  return {
    deps: {
      makeHome: () => 'T:/home1',
      makeDir: path => made.push(path),
      removeHome: path => removed.push(path),
      spawn: (file, args, env) => {
        calls.push({ file, args, env });
        if (status instanceof Error) throw status;
        return status;
      },
      env: { PATH: 'C:/bin', HOME: 'C:/Users/me', CLAUDE_CONFIG_DIR: 'C:/Users/me/.claude' },
      err: line => err.push(line),
    },
    calls,
    made,
    removed,
    err,
  };
}

test('runs the plugin tests with an empty home and config folder, then removes them', () => {
  const { deps, calls, made, removed } = fakeDeps(0);
  assert.equal(runPluginTests(['plugins/teamrig-pane'], deps), 0);
  const config = join('T:/home1', '.claude');
  assert.deepEqual(made, [config]);
  assert.deepEqual(calls, [{ file: 'claude', args: ['plugin', 'test', 'plugins/teamrig-pane'], env: { PATH: 'C:/bin', HOME: 'T:/home1', USERPROFILE: 'T:/home1', CLAUDE_CONFIG_DIR: config } }]);
  assert.deepEqual(removed, ['T:/home1']);
});

test('passes on the exit code of a failing run, and says so when claude does not start', () => {
  assert.equal(runPluginTests(['p'], fakeDeps(3).deps), 3);
  const missing = fakeDeps(null);
  assert.equal(runPluginTests(['p'], missing.deps), 1);
  assert.deepEqual(missing.err, ['plugin-test: claude did not start: is Claude Code installed and on PATH?']);
  assert.deepEqual(missing.removed, ['T:/home1']);
});

test('removes the home even when the run throws', () => {
  const thrown = fakeDeps(new Error('spawn failed'));
  assert.throws(() => runPluginTests(['p'], thrown.deps), /spawn failed/);
  assert.deepEqual(thrown.removed, ['T:/home1']);
});

test('refuses a missing plugin dir, a flag or a second argument without making a home', () => {
  for (const argv of [[], ['--all'], ['a', 'b']]) {
    const { deps, err, made } = fakeDeps(0);
    assert.equal(runPluginTests(argv, deps), 1);
    assert.deepEqual(err, ['usage: plugin-test.ts <plugin dir>']);
    assert.deepEqual(made, []);
  }
});

test('the isolated environment keeps everything but the home and config folder', () => {
  assert.deepEqual(isolatedEnv({ A: '1', HOME: 'x' }, 'H'), { A: '1', HOME: 'H', USERPROFILE: 'H', CLAUDE_CONFIG_DIR: join('H', '.claude') });
});

test('the real deps make and remove a temp home, return a process exit code and print errors', t => {
  const home = realPluginTestDeps.makeHome();
  realPluginTestDeps.makeDir(join(home, '.claude'));
  assert.ok(existsSync(join(home, '.claude')));
  realPluginTestDeps.removeHome(home);
  assert.ok(!existsSync(home));
  assert.equal(realPluginTestDeps.spawn(process.execPath, ['-e', 'process.exit(4)'], process.env), 4);
  assert.equal(realPluginTestDeps.spawn('no-such-command-here', [], process.env), null);
  assert.equal(realPluginTestDeps.env, process.env);
  const error = t.mock.method(console, 'error', () => undefined);
  realPluginTestDeps.err('e');
  assert.deepEqual(error.mock.calls[0]?.arguments, ['e']);
});
