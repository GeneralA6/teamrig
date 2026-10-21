import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ReviewPath } from '../config/types.ts';
import { GENERIC_REVIEW_PATHS, reviewHits, reviewPathMatcher } from './review-paths.ts';

const generic = (path: string): readonly string[] => reviewHits([path], GENERIC_REVIEW_PATHS).map(({ entry }) => entry.glob);

describe('reviewPathMatcher', () => {
  it('reads a glob with no slash as a file name at any depth', () => {
    const matches = reviewPathMatcher('hooks.json');
    assert.equal(matches('hooks.json'), true);
    assert.equal(matches('plugins/kit/hooks/hooks.json'), true);
    assert.equal(matches('plugins/kit/hooks/hooks.json.bak'), false);
  });

  it('reads a glob with a slash from the repo root, a leading slash included', () => {
    assert.equal(reviewPathMatcher('.github/workflows/**')('.github/workflows/ci.yml'), true);
    assert.equal(reviewPathMatcher('.github/workflows/**')('app/.github/workflows/ci.yml'), false);
    assert.equal(reviewPathMatcher('/k8s/**')('k8s/base/deploy.yaml'), true);
    assert.equal(reviewPathMatcher('**/.husky/**')('app/.husky/pre-commit'), true);
  });

  it('ignores case and reads backslashes as folder separators', () => {
    assert.equal(reviewPathMatcher('Dockerfile')('services/api/DOCKERFILE'), true);
    assert.equal(reviewPathMatcher('**/.claude/hooks/**')('.Claude\\Hooks\\guard.ts'), true);
  });
});

describe('reviewHits', () => {
  const entries: readonly ReviewPath[] = [
    { glob: 'Makefile', mode: 'check', class: 'security' },
    { glob: 'src/auth/**', mode: 'always', class: 'security' },
    { glob: 'src/**', mode: 'check', class: 'leader' },
  ];

  it('gives each covered path with each entry covering it, in order', () => {
    assert.deepEqual(reviewHits(['README.md', 'src/auth/login.ts', 'Makefile'], entries), [
      { path: 'src/auth/login.ts', entry: entries[1] },
      { path: 'src/auth/login.ts', entry: entries[2] },
      { path: 'Makefile', entry: entries[0] },
    ]);
  });

  it('hits nothing for no paths or no entries', () => {
    assert.deepEqual(reviewHits([], entries), []);
    assert.deepEqual(reviewHits(['Makefile'], []), []);
  });
});

describe('GENERIC_REVIEW_PATHS', () => {
  it('holds every entry for security, always', () => {
    assert.ok(GENERIC_REVIEW_PATHS.length > 0);
    assert.ok(GENERIC_REVIEW_PATHS.every(({ mode, class: reviewer }) => mode === 'always' && reviewer === 'security'));
  });

  it('covers lockfiles, package manager config, git and agent hooks, CI, deploy files and git attributes', () => {
    for (const path of [
      'package-lock.json',
      'api/pnpm-lock.yaml',
      'yarn.lock',
      '.npmrc',
      'web/.yarnrc.yml',
      '.husky/pre-push',
      '.githooks/commit-msg',
      '.claude/hooks/guard.ts',
      '.claude/settings.local.json',
      'plugins/kit/hooks/hooks.json',
      '.github/workflows/ci.yml',
      'Procfile',
      'services/api/Dockerfile',
      'Dockerfile.dev',
      'worker.dockerfile',
      '.dockerignore',
      '.gitmodules',
      'assets/.gitattributes',
    ]) {
      assert.notDeepEqual(generic(path), [], path);
    }
  });

  it('leaves ordinary source, docs and tests alone', () => {
    for (const path of ['src/index.ts', 'README.md', 'src/hooks/useThing.test.ts', 'docs/workflows/ci.md', 'package.json']) {
      assert.deepEqual(generic(path), [], path);
    }
  });
});
