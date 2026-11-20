import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { TempRepo } from '../lib/temp-repo.ts';
import { profileFor, readProfiles, type RepoProfile } from '../ship/repos.ts';
import { TEAMRIG_SHIP_VERSION_FILES } from '../ship/version-bump.ts';
import type { AppKey, Fetch, GateDeps, GateOutcome, GateTarget, MergeDeps, MergeOutcome, MergeTarget } from './release-merge.ts';
import { gateCommand, gateSummary, mergeCommand, type Env } from './release-merge-commands.ts';

const REPO = 'acme/tool';
const HEAD_BRANCH = 'release-please--branches--main';
const SHA = 'b'.repeat(40);
const PLUGIN = 'plugins/teamrig/.claude-plugin/plugin.json';
const VERSION_TS = 'src/core/version.ts';
const MANIFEST = '.release-please-manifest.json';
const CHANGELOG = 'CHANGELOG.md';
const NOTES_BASE = '# Changelog\n\n## 0.1.0\n\n- first\n';

// teamrig's own profile, moved to a test repository and given every version file, so the spec holds the command's
// wiring and not repos.json's values.
const PROFILE: RepoProfile = {
  ...profileFor(readProfiles(), 'teamrig/teamrig'),
  main: 'main',
  summary: 'every check passed',
  release: { head: HEAD_BRANCH, changelog: CHANGELOG },
  regenerated: TEAMRIG_SHIP_VERSION_FILES.map((file) => file.path),
};
const PROFILES: ReadonlyMap<string, RepoProfile> = new Map([[REPO, PROFILE]]);

const noFetch: Fetch = async () => {
  throw new Error('the command itself never calls GitHub');
};

interface GateCall {
  readonly target: GateTarget;
  readonly token: string;
}

describe('gateCommand', () => {
  let repo: TempRepo;
  let output: string;
  let summary: string;
  let printed: string[];
  let calls: GateCall[];

  const commit = (subject: string, files: Readonly<Record<string, string>>): string => {
    for (const [path, text] of Object.entries(files)) repo.write(path, text);
    repo.git('add', '--', ...Object.keys(files));
    repo.git('commit', '-q', '-m', subject);
    return repo.git('rev-parse', 'HEAD').trim();
  };
  const versions = (version: string): Record<string, string> => ({
    [PLUGIN]: `{\n  "name": "teamrig",\n  "version": "${version}"\n}\n`,
    [VERSION_TS]: `export const KIT_VERSION = '${version}';\n`,
    [MANIFEST]: `{\n  ".": "${version}"\n}\n`,
  });
  const notes = (version: string): string => NOTES_BASE.replace('# Changelog\n', `# Changelog\n\n## ${version}\n\n- a feature\n`);

  /** A release branch holding `files` over main, with main checked out again as the job's checkout is. */
  const releaseBranch = (...commits: readonly Readonly<Record<string, string>>[]): string => {
    repo.git('checkout', '-q', '-b', HEAD_BRANCH);
    let sha = '';
    for (const files of commits) sha = commit('chore(main): release 0.2.0', files);
    repo.git('checkout', '-q', 'main');
    return sha;
  };

  /** A gate that asks the files check about `sha`, as releaseGate does, and answers from it. */
  const gateAsking = (sha: string, pass: (refusal: string | null) => GateOutcome) => async (target: GateTarget, deps: GateDeps): Promise<GateOutcome> => {
    calls.push({ target, token: deps.token });
    return pass(deps.filesRefusal(sha));
  };
  const gateAnswering = (outcome: GateOutcome) => async (target: GateTarget, deps: GateDeps): Promise<GateOutcome> => {
    calls.push({ target, token: deps.token });
    return outcome;
  };

  const env = (over: Env = {}): Env => ({
    GITHUB_REPOSITORY: REPO,
    RUN_ID: '7',
    GITHUB_TOKEN: 'read-token',
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
    ...over,
  });
  const run = (gate: (target: GateTarget, deps: GateDeps) => Promise<GateOutcome>, over: Env = {}, profiles = PROFILES): Promise<number> =>
    gateCommand(env(over), { git: (args) => repo.git(...args), profiles, gate, fetchFn: noFetch, out: (text) => printed.push(text) });

  beforeEach(() => {
    repo = new TempRepo('release-merge-commands').init();
    repo.git('symbolic-ref', 'HEAD', 'refs/heads/main');
    commit('base', { ...versions('0.1.0'), [CHANGELOG]: NOTES_BASE, 'src/a.ts': 'a\n' });
    repo.git('remote', 'add', 'origin', repo.dir);
    output = join(repo.outside, 'output');
    summary = join(repo.outside, 'summary');
    writeFileSync(output, '');
    writeFileSync(summary, '');
    printed = [];
    calls = [];
  });

  afterEach(() => repo.remove());

  it('passes the gate the run, the profile and the token, and writes a pass with the paths the release changed', async () => {
    const sha = releaseBranch({ ...versions('0.2.0'), [CHANGELOG]: notes('0.2.0') });
    const code = await run(gateAsking(sha, (refusal) => (refusal === null ? { kind: 'pass', pr: 12, sha, checks: 9 } : { kind: 'refused', reason: refusal })));
    assert.equal(code, 0);
    assert.deepEqual(calls, [{ target: { repo: REPO, runId: 7, main: 'main', head: HEAD_BRANCH, summary: 'every check passed' }, token: 'read-token' }]);
    assert.equal(readFileSync(output, 'utf8'), `pass=true\npr=12\nsha=${sha}\nchecks=9\npaths=${[MANIFEST, CHANGELOG, PLUGIN, VERSION_TS].join(',')}\n`);
    const said = `Release merge gate passed pull request #12 at \`${sha}\`: 9 checks green.\n`;
    assert.equal(readFileSync(summary, 'utf8'), said);
    assert.deepEqual(printed, [said]);
  });

  it("refuses with exit 1 and pass=false when the files check refuses the head, naming the check's reason", async () => {
    const sha = releaseBranch({ 'src/a.ts': 'a, slipped in\n' }, { ...versions('0.2.0'), [CHANGELOG]: notes('0.2.0'), 'src/a.ts': 'a\n' });
    const code = await run(gateAsking(sha, (refusal) => (refusal === null ? { kind: 'pass', pr: 12, sha, checks: 9 } : { kind: 'refused', reason: refusal })));
    assert.equal(code, 1);
    assert.equal(readFileSync(output, 'utf8'), 'pass=false\n');
    assert.match(readFileSync(summary, 'utf8'), /^Release merge gate refused: the release pull request's head [0-9a-f]{40} is not one commit on HEAD/);
  });

  it('exits 0 with pass=false when there is nothing to merge', async () => {
    const code = await run(gateAnswering({ kind: 'stale', reason: 'no release pull request is open' }));
    assert.equal(code, 0);
    assert.equal(readFileSync(output, 'utf8'), 'pass=false\n');
    assert.equal(readFileSync(summary, 'utf8'), 'Release merge gate found nothing to merge: no release pull request is open\n');
  });

  it('throws before the gate runs on a missing output file, a malformed run id or a repository with no release', async () => {
    const gate = gateAnswering({ kind: 'stale', reason: 'unused' });
    await assert.rejects(run(gate, { GITHUB_STEP_SUMMARY: '' }), /GITHUB_STEP_SUMMARY is not set/);
    await assert.rejects(run(gate, { RUN_ID: '7 8' }), /RUN_ID is not in the form/);
    await assert.rejects(run(gate, {}, new Map([[REPO, { ...PROFILE, release: null }]])), /repos\.json names no release pull request or summary check for acme\/tool/);
    await assert.rejects(run(gate, {}, new Map([[REPO, { ...PROFILE, summary: null }]])), /names no release pull request or summary check/);
    assert.deepEqual(calls, []);
    assert.equal(readFileSync(output, 'utf8'), '');
  });
});

describe('gateSummary', () => {
  it('keeps a sha a code span and says refused for a refusal', () => {
    assert.equal(gateSummary({ kind: 'refused', reason: 'a check failed' }), 'Release merge gate refused: a check failed\n');
  });
});

describe('mergeCommand', () => {
  const MERGE_ENV: Env = {
    GITHUB_REPOSITORY: REPO,
    PR: '12',
    SHA,
    CHECKS: '9',
    PATHS: `${CHANGELOG},${PLUGIN}`,
    RUN_URL: 'https://github.com/acme/tool/actions/runs/8',
    APP_ID: '42',
    APP_KEY: 'the key',
  };

  interface MergeCall {
    readonly target: MergeTarget;
    readonly key: AppKey;
    readonly now: number;
  }

  const runMerge = async (outcome: MergeOutcome, over: Env = {}) => {
    const calls: MergeCall[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const code = await mergeCommand(
      { ...MERGE_ENV, ...over },
      {
        merge: async (target: MergeTarget, key: AppKey, deps: MergeDeps): Promise<MergeOutcome> => {
          calls.push({ target, key, now: deps.nowSeconds() });
          return outcome;
        },
        fetchFn: noFetch,
        nowSeconds: () => 1000,
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      },
    );
    return { code, calls, out, err };
  };

  it('merges the gated head with the App key and exits 0 once it merged, commented and revoked', async () => {
    const result = await runMerge({ kind: 'merged', sha: 'c'.repeat(40), commented: true, revoked: true });
    assert.equal(result.code, 0);
    assert.deepEqual(result.calls, [
      {
        target: { repo: REPO, pr: 12, sha: SHA, checks: 9, paths: [CHANGELOG, PLUGIN], runUrl: 'https://github.com/acme/tool/actions/runs/8' },
        key: { appId: 42, privateKey: 'the key' },
        now: 1000,
      },
    ]);
    assert.deepEqual(result.out, [`release pull request #12 merged as ${'c'.repeat(40)}; the App token was revoked`]);
    assert.deepEqual(result.err, []);
  });

  it('exits 1 on a merge without its comment, saying it counts as an incident and that the token stays to its expiry', async () => {
    const result = await runMerge({ kind: 'merged', sha: 'c'.repeat(40), commented: false, revoked: false });
    assert.equal(result.code, 1);
    assert.deepEqual(result.out, [`release pull request #12 merged as ${'c'.repeat(40)}; the App token could not be revoked: it expires within the hour`]);
    assert.deepEqual(result.err, ["the gate comment could not be posted: teamrig's GitHub watch counts this merge as an incident until one is"]);
  });

  it('exits 1 on a refused merge, naming the reason and never the key', async () => {
    const result = await runMerge({ kind: 'refused', reason: 'GitHub answered PUT /repos/acme/tool/pulls/12/merge with 409', revoked: true });
    assert.equal(result.code, 1);
    assert.deepEqual(result.out, []);
    assert.deepEqual(result.err, ['release merge refused: GitHub answered PUT /repos/acme/tool/pulls/12/merge with 409; the App token was revoked']);
    assert.doesNotMatch(result.err.join('\n'), /the key/);
  });

  it('throws before the merge on a malformed value', async () => {
    for (const [name, value] of [['PR', '12a'], ['CHECKS', ''], ['RUN_URL', 'http://example.test/run'], ['APP_ID', 'x'], ['APP_KEY', undefined]] as const) {
      const outcome: MergeOutcome = { kind: 'merged', sha: SHA, commented: true, revoked: true };
      await assert.rejects(runMerge(outcome, { [name]: value }), new RegExp(`${name} is not`));
    }
  });
});
