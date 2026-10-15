import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TempRepo } from '../lib/temp-repo.ts';

const CLI = fileURLToPath(new URL('./plugin-version-cli.ts', import.meta.url));
const MANIFEST = 'plugins/demo/.claude-plugin/plugin.json';
const UNRAISED = `plugin-version: demo: 1 file(s) under plugins/demo/ changed, but ${MANIFEST} still gives 0.1.0 (the base: 0.1.0); raise it, or installed copies never receive the change\n`;

describe('plugin-version cli', () => {
  let repo: TempRepo;
  let mainSha: string;

  /** Commits every change in the work tree; returns the new commit's sha. */
  function commit(message: string): string {
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', message);
    return repo.git('rev-parse', 'HEAD').trim();
  }

  beforeEach(() => {
    repo = new TempRepo('plugin-version').init();
    repo.write('.claude-plugin/marketplace.json', JSON.stringify({ name: 'demo', plugins: [{ name: 'demo', source: './plugins/demo' }] }));
    repo.write(MANIFEST, JSON.stringify({ name: 'demo', version: '0.1.0' }));
    repo.write('plugins/demo/hooks/a.ts', 'export const a = 1;\n');
    mainSha = commit('first');
    repo.git('branch', '-M', 'main');
    repo.git('checkout', '-q', '-b', 'change');
  });
  afterEach(() => repo.remove());

  it('fails a change to the plugin that keeps the version, and passes it once the version rises', () => {
    repo.write('plugins/demo/hooks/a.ts', 'export const a = 2;\n');
    commit('change a');
    assert.deepEqual(repo.run(CLI, ['--base', 'main']), { status: 1, stdout: UNRAISED, stderr: '' });
    repo.write(MANIFEST, JSON.stringify({ name: 'demo', version: '0.1.1' }));
    commit('release 0.1.1');
    const raised = repo.run(CLI, ['--base', 'main']);
    assert.equal(raised.status, 0, raised.stderr);
    assert.equal(raised.stdout, 'plugin-version: demo 0.1.0 -> 0.1.1: 2 file(s) under plugins/demo/ changed\n');
  });

  it('compares with origin/main by default', () => {
    repo.git('update-ref', 'refs/remotes/origin/main', mainSha);
    repo.write('README.md', 'docs only\n');
    commit('docs');
    const result = repo.run(CLI);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'plugin-version: demo 0.1.0: nothing under plugins/demo/ changed\n');
  });

  it("takes a pull request's base and head from the GitHub Actions event with --github", () => {
    repo.write('plugins/demo/hooks/a.ts', 'export const a = 3;\n');
    const head = commit('change a');
    const event = join(repo.outside, 'event.json');
    writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: mainSha }, head: { sha: head } } }));
    const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event, GITHUB_SHA: head };
    assert.deepEqual(repo.run(CLI, ['--github'], env), { status: 1, stdout: UNRAISED, stderr: '' });
  });

  it('has nothing to compare for a push that creates a branch', () => {
    const event = join(repo.outside, 'event.json');
    writeFileSync(event, JSON.stringify({ before: '0'.repeat(40), after: mainSha }));
    const result = repo.run(CLI, ['--github'], { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event, GITHUB_SHA: mainSha });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'plugin-version: no base commit to compare with (a new branch), nothing to check\n');
  });

  it('exits 2 on an unknown option, --github outside Actions or a base git cannot find', () => {
    const unknown = repo.run(CLI, ['--bogus']);
    assert.equal(unknown.status, 2, unknown.stdout);
    assert.match(unknown.stderr, /^plugin-version: Unknown option '--bogus'/);
    const github = repo.run(CLI, ['--github']);
    assert.equal(github.status, 2, github.stdout);
    assert.equal(github.stderr, 'plugin-version: --github needs GITHUB_EVENT_NAME, GITHUB_EVENT_PATH and GITHUB_SHA\n');
    const missing = repo.run(CLI, ['--base', 'no-such-branch']);
    assert.equal(missing.status, 2, missing.stdout);
    assert.match(missing.stderr, /^plugin-version: git merge-base no-such-branch HEAD failed/);
  });
});
