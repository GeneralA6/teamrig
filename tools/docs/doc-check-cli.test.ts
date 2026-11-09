import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { TOOLS_REPO } from '../lib/repo-root.ts';
import { type CliRun, TempRepo } from '../lib/temp-repo.ts';

const CLI = fileURLToPath(new URL('./doc-check-cli.ts', import.meta.url));

describe('doc-check-cli', () => {
  let repo: TempRepo;
  /** Runs the CLI on the temp repo from a folder outside it, so a check by the cwd would read the wrong files. */
  const check = (args: readonly string[] = []): CliRun => repo.runOutside(CLI, [...args, '--root', repo.dir]);
  beforeEach(() => {
    repo = new TempRepo('docs');
  });
  afterEach(() => repo.remove());

  it('passes when every link, anchor and diagram in the top-level and docs/ Markdown of the --root repo checks out', () => {
    repo.write('README.md', '# app\n[how](docs/guide/how.md#parts)\n');
    repo.write('CONTRIBUTING.md', '[back](README.md#app)\n');
    repo.write('docs/guide/how.md', '## Parts\n```mermaid\nflowchart LR\n  a --> b\n```\n');
    repo.write('docs/notes.txt', '[not markdown](missing.md)\n');
    const result = check();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'docs: 3 file(s), 2 link(s) and 1 diagram(s) check out\n');
  });

  it('works in a repo with no docs folder', () => {
    repo.write('README.md', '# app\n');
    const result = check();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'docs: 1 file(s), 0 link(s) and 0 diagram(s) check out\n');
  });

  it('lists each problem with its file and line and exits 1', () => {
    repo.write('README.md', '# app\n[a](docs/missing.md)\n');
    repo.write('docs/how.md', '```mermaid\npie chart\n```\n');
    const result = check();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^docs: 2 problem\(s\):\n {2}README\.md:2 docs\/missing\.md: no file docs\/missing\.md\n {2}docs\/how\.md:1 a mermaid block opens with "pie chart"/);
  });

  it('checks its own repo, not the cwd, when no --root is given', () => {
    repo.write('README.md', '# app\n[a](docs/missing.md)\n');
    const foreign = repo.run(CLI);
    assert.equal(foreign.stderr, '');
    assert.deepEqual(foreign, repo.run(CLI, ['--root', TOOLS_REPO]));
  });

  it('exits 2 on an unknown option', () => {
    const result = check(['--fix']);
    assert.equal(result.status, 2);
    assert.equal(result.stderr, 'docs: unknown option --fix (usage: doc-check-cli.ts [--root <repo>])\n');
  });
});
