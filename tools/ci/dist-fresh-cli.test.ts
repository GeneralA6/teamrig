import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TempRepo } from '../lib/temp-repo.ts';
import { DIST_DIR } from './dist-fresh.ts';

const CLI = fileURLToPath(new URL('./dist-fresh-cli.ts', import.meta.url));
const MAIN = `${DIST_DIR}/cli/main.js`;

describe('dist-fresh-cli', () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = new TempRepo('dist-fresh');
  });
  afterEach(() => repo.remove());

  it('passes when the dist matches the committed one', () => {
    repo.init().write(MAIN, 'export {};\n');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'build');
    const result = repo.run(CLI);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `dist-fresh: ${DIST_DIR} matches the source\n`);
  });

  it('lists every changed and new dist file and exits 1', () => {
    repo.init().write(MAIN, 'export {};\n');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'build');
    repo.write(MAIN, 'export const changed = 1;\n');
    repo.write(`${DIST_DIR}/cli/extra.js`, 'export {};\n');
    const result = repo.run(CLI);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /is stale; run `npm run build` and commit the result:/);
    assert.match(result.stdout, new RegExp(`^ {2} M ${MAIN}$`, 'm'));
    assert.match(result.stdout, new RegExp(`^ {2}\\?\\? ${DIST_DIR}/cli/extra\\.js$`, 'm'));
  });

  describe('with --github on a pull request (T3029)', () => {
    const SOURCE = 'src/a.ts';
    let event: string;

    /** The base with a built dist, then the pull request's commit; its build then leaves the dist behind the source. */
    function pullRequest(from: string, changesDist: boolean): Readonly<Record<string, string>> {
      repo.init().write(MAIN, 'export {};\n');
      repo.write(SOURCE, 'export const a = 1;\n');
      repo.git('add', '-A');
      repo.git('commit', '-q', '-m', 'base');
      repo.write(SOURCE, 'export const a = 2;\n');
      if (changesDist) repo.write(MAIN, 'export const handMade = 1;\n');
      repo.git('add', '-A');
      repo.git('commit', '-q', '-m', 'change');
      repo.write(MAIN, 'export const a = 2;\n');
      event = join(repo.outside, 'event.json');
      writeFileSync(event, JSON.stringify({ pull_request: { base: { repo: { full_name: 'owner/teamrig' } }, head: { repo: { full_name: from } } } }));
      return { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event, GITHUB_SHA: repo.git('rev-parse', 'HEAD').trim() };
    }

    it("passes a fork's pull request that leaves the dist alone: the release pull request rebuilds it", () => {
      const result = repo.run(CLI, ['--github'], pullRequest('someone/teamrig', false));
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `dist-fresh: ${DIST_DIR} is behind the source, but the pull request from someone/teamrig leaves it as it is: the release pull request after its merge rebuilds it\n`);
    });

    it("fails a fork's pull request whose own dist change is not the build, so no hand-made dist lands", () => {
      const result = repo.run(CLI, ['--github'], pullRequest('someone/teamrig', true));
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /is stale; run `npm run build` and commit the result:/);
    });

    it("fails a stale dist on a pull request from the repository's own branch", () => {
      const result = repo.run(CLI, ['--github'], pullRequest('owner/teamrig', false));
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /is stale/);
    });

    it('exits 2 when --github runs outside Actions', () => {
      repo.init().write(MAIN, 'export {};\n');
      repo.git('add', '-A');
      repo.git('commit', '-q', '-m', 'build');
      repo.write(MAIN, 'export const changed = 1;\n');
      const result = repo.run(CLI, ['--github'], { GITHUB_EVENT_NAME: undefined, GITHUB_EVENT_PATH: undefined, GITHUB_SHA: undefined });
      assert.equal(result.status, 2, result.stdout);
      assert.equal(result.stderr, 'dist-fresh: --github needs GITHUB_EVENT_NAME, GITHUB_EVENT_PATH and GITHUB_SHA\n');
    });
  });

  it('exits 2 with the git error outside a repo', () => {
    const result = repo.run(CLI);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /^dist-fresh: git status .* failed: /);
  });
});
