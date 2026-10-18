import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeIntegrateGit, MAIN_CHECKOUT } from '../testing/fake-integrate-git.ts';
import { rangeInstallTouches } from './dependencies.ts';

const manifest = (dependencies: Readonly<Record<string, string>>, scripts: Readonly<Record<string, string>> = {}): string => JSON.stringify({ name: 'app', scripts, dependencies });

describe('rangeInstallTouches', () => {
  it('names the lockfile and a package.json change beyond its scripts, read at both ends of the range', async () => {
    const git = new FakeIntegrateGit();
    git.paths = ['package.json', 'package-lock.json', 'src/app.ts'];
    git.files.set('base:package.json', manifest({ left: '1.0.0' }));
    git.files.set('next:package.json', manifest({ left: '1.0.1' }));
    assert.deepEqual(await rangeInstallTouches(git, MAIN_CHECKOUT, 'base', 'next'), ['package-lock.json', 'package.json beyond scripts']);
  });

  it('passes a range that changes only package.json scripts or no package file', async () => {
    const git = new FakeIntegrateGit();
    git.paths = ['package.json'];
    git.files.set('base:package.json', manifest({ left: '1.0.0' }, { test: 'node --test' }));
    git.files.set('next:package.json', manifest({ left: '1.0.0' }, { test: 'node --test --experimental-test-coverage' }));
    assert.deepEqual(await rangeInstallTouches(git, MAIN_CHECKOUT, 'base', 'next'), []);
    git.paths = ['src/app.ts'];
    assert.deepEqual(await rangeInstallTouches(git, MAIN_CHECKOUT, 'base', 'next'), []);
  });

  it('is undefined when the range’s paths cannot be read', async () => {
    const git = new FakeIntegrateGit();
    git.paths = undefined;
    assert.equal(await rangeInstallTouches(git, MAIN_CHECKOUT, 'base', 'next'), undefined);
  });
});
