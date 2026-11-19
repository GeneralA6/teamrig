import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TempRepo } from '../lib/temp-repo.ts';

const CLI = fileURLToPath(new URL('./change-kind-cli.ts', import.meta.url));
const CODE_OUTPUT = 'kind=code\nsystems=["ubuntu-latest","windows-latest","macos-latest"]\n';
const DOCS_OUTPUT = 'kind=docs\nsystems=["ubuntu-latest"]\n';

describe('change-kind cli', () => {
  let repo: TempRepo;
  let mainSha: string;

  /** Commits every change in the work tree; returns the new commit's sha. */
  function commit(message: string): string {
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', message);
    return repo.git('rev-parse', 'HEAD').trim();
  }

  /** The event file of a pull request from `base` to `head`, and the environment a --github run reads. */
  function pullRequestEnv(base: string, head: string): { env: Record<string, string>; output: string } {
    const event = join(repo.outside, 'event.json');
    const output = join(repo.outside, 'output.txt');
    writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head } } }));
    writeFileSync(output, '');
    return { env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event, GITHUB_SHA: head, GITHUB_OUTPUT: output }, output };
  }

  beforeEach(() => {
    repo = new TempRepo('change-kind').init();
    repo.write('src/a.ts', 'export {};\n');
    repo.write('docs/a.md', '# A\n');
    mainSha = commit('first');
    repo.git('branch', '-M', 'main');
    repo.git('checkout', '-q', '-b', 'change');
  });
  afterEach(() => repo.remove());

  it("writes a docs-only pull request's kind and its one test runner to the step output", () => {
    repo.write('docs/a.md', '# A, again\n');
    repo.write('README.md', '# Readme\n');
    const { env, output } = pullRequestEnv(mainSha, commit('docs'));
    const result = repo.run(CLI, ['--github'], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^change-kind: docs: 2 file\(s\) changed in [0-9a-f]{40}\.\.\.[0-9a-f]{40}\n$/);
    assert.equal(readFileSync(output, 'utf8'), DOCS_OUTPUT);
  });

  it('is code for a file moved from src/ into docs/, as both sides of the rename count', () => {
    repo.git('mv', 'src/a.ts', 'docs/a.ts');
    const { env, output } = pullRequestEnv(mainSha, commit('move'));
    const result = repo.run(CLI, ['--github'], env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, 'utf8'), CODE_OUTPUT);
  });

  it("leaves out what main took since the branch was cut, comparing from their common ancestor", () => {
    repo.write('docs/b.md', '# B\n');
    const head = commit('docs');
    repo.git('checkout', '-q', 'main');
    repo.write('src/b.ts', 'export {};\n');
    const movedMain = commit('code on main');
    repo.git('checkout', '-q', 'change');
    const { env, output } = pullRequestEnv(movedMain, head);
    const result = repo.run(CLI, ['--github'], env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, 'utf8'), DOCS_OUTPUT);
  });

  it("gives a merge queue group of a docs-only change the same light kind as its pull request (T3386)", () => {
    repo.write('docs/a.md', '# A, queued\n');
    const head = commit('docs');
    const event = join(repo.outside, 'event.json');
    const output = join(repo.outside, 'output.txt');
    writeFileSync(event, JSON.stringify({ merge_group: { base_sha: mainSha, head_sha: head } }));
    writeFileSync(output, '');
    const result = repo.run(CLI, ['--github'], { GITHUB_EVENT_NAME: 'merge_group', GITHUB_EVENT_PATH: event, GITHUB_SHA: head, GITHUB_OUTPUT: output });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, 'utf8'), DOCS_OUTPUT);
  });

  it('is code for a push that creates a branch, with nothing to compare', () => {
    const event = join(repo.outside, 'event.json');
    const output = join(repo.outside, 'output.txt');
    writeFileSync(event, JSON.stringify({ before: '0'.repeat(40), after: mainSha }));
    writeFileSync(output, '');
    const result = repo.run(CLI, ['--github'], { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event, GITHUB_SHA: mainSha, GITHUB_OUTPUT: output });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^change-kind: code: no base commit to compare with/);
    assert.equal(readFileSync(output, 'utf8'), CODE_OUTPUT);
  });

  it('refuses --github with no step output file, so no later job reads a missing kind', () => {
    const { env } = pullRequestEnv(mainSha, mainSha);
    const result = repo.run(CLI, ['--github'], { ...env, GITHUB_OUTPUT: undefined });
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /--github needs GITHUB_OUTPUT/);
  });

  it('compares with origin/main by default and prints the kind alone', () => {
    repo.git('update-ref', 'refs/remotes/origin/main', mainSha);
    repo.write('docs/design/x.md', '# X\n');
    commit('design');
    const result = repo.run(CLI);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'change-kind: design: 1 file(s) changed in origin/main...HEAD\n');
  });
});
