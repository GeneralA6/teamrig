import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { HookRunner } from '../roll/hooks.ts';
import { FakeHooks } from '../testing/fake-hooks.ts';
import { FakeMergeGit, MAIN_CHECKOUT } from '../testing/fake-merge-git.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { BASELINE_LOCK_ENV, rangeInstallTouches, runDependencyCheck, type DependencyCheck } from './dependencies.ts';

const manifest = (dependencies: Readonly<Record<string, string>>, scripts: Readonly<Record<string, string>> = {}): string => JSON.stringify({ name: 'app', scripts, dependencies });

describe('rangeInstallTouches', () => {
  it('names the lockfile and a package.json change an install reads, read at both ends of the range', async () => {
    const git = new FakeMergeGit();
    git.paths = ['package.json', 'package-lock.json', 'src/app.ts'];
    git.files.set('base:package.json', manifest({ left: '1.0.0' }));
    git.files.set('next:package.json', manifest({ left: '1.0.1' }));
    assert.deepEqual(await rangeInstallTouches(git, MAIN_CHECKOUT, 'base', 'next'), ['package-lock.json', 'package.json fields an install reads']);
  });

  it('passes a range that changes only package.json scripts or no package file', async () => {
    const git = new FakeMergeGit();
    git.paths = ['package.json'];
    git.files.set('base:package.json', manifest({ left: '1.0.0' }, { test: 'node --test' }));
    git.files.set('next:package.json', manifest({ left: '1.0.0' }, { test: 'node --test --experimental-test-coverage' }));
    assert.deepEqual(await rangeInstallTouches(git, MAIN_CHECKOUT, 'base', 'next'), []);
    git.paths = ['src/app.ts'];
    assert.deepEqual(await rangeInstallTouches(git, MAIN_CHECKOUT, 'base', 'next'), []);
  });

  it('is undefined when the range’s paths cannot be read', async () => {
    const git = new FakeMergeGit();
    git.paths = undefined;
    assert.equal(await rangeInstallTouches(git, MAIN_CHECKOUT, 'base', 'next'), undefined);
  });
});

describe('runDependencyCheck', () => {
  const FOLDER = '/team/deploys';
  const BASELINE = join(FOLDER, 'baseline-id-1.package-lock.json');
  const check = (baseline: string | undefined, lines: string[] = []): DependencyCheck => ({
    argv: ['node', 'check-change.ts'],
    cwd: MAIN_CHECKOUT,
    baseline,
    folder: FOLDER,
    env: { PATH: '/bin', TEAMRIG_HOST_LOCK: 'lock-1' },
    timeoutMs: 60_000,
    onLine: (line) => lines.push(line),
  });

  it('runs the check with the base’s lockfile in the file the variable names, removed after', async () => {
    const files = new MemoryFiles();
    const hooks = new FakeHooks();
    const seen: (string | undefined)[] = [];
    hooks.answer(['node', 'check-change.ts'], {
      lines: ['pins hold'],
      end: 3,
      during: async (request) => {
        const path = request.env[BASELINE_LOCK_ENV];
        seen.push(path, path === undefined ? undefined : files.get(path));
      },
    });
    const lines: string[] = [];
    assert.deepEqual(await runDependencyCheck({ hooks, files, newId: () => 'id-1' }, check('{"lockfileVersion":3}', lines)), { kind: 'exited', code: 3 });
    assert.deepEqual(seen, [BASELINE, '{"lockfileVersion":3}']);
    assert.deepEqual([hooks.ran[0]?.cwd, hooks.ran[0]?.env['PATH'], hooks.ran[0]?.env['TEAMRIG_HOST_LOCK'], hooks.ran[0]?.timeoutMs], [MAIN_CHECKOUT, '/bin', 'lock-1', 60_000]);
    assert.deepEqual(lines, ['pins hold']);
    assert.equal(files.get(BASELINE), undefined);
  });

  it('leaves the variable unset and writes nothing when the base has no lockfile', async () => {
    const files = new MemoryFiles();
    const hooks = new FakeHooks();
    assert.deepEqual(await runDependencyCheck({ hooks, files, newId: () => 'id-1' }, check(undefined)), { kind: 'exited', code: 0 });
    assert.equal(hooks.ran[0]?.env[BASELINE_LOCK_ENV], undefined);
    assert.equal(files.get(BASELINE), undefined);
  });

  it('removes the lockfile copy when the run throws', async () => {
    const files = new MemoryFiles();
    const hooks: HookRunner = {
      run: async () => {
        throw new Error('spawn EPERM');
      },
    };
    await assert.rejects(runDependencyCheck({ hooks, files, newId: () => 'id-1' }, check('{}')), /spawn EPERM/);
    assert.equal(files.get(BASELINE), undefined);
  });
});
