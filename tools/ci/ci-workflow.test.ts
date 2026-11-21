import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TEST_SYSTEMS } from './change-kind.ts';

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');

/** Each job's id and its lines, from the `jobs:` map (two-space ids, deeper lines belong to the job above). */
function jobsOf(text: string): ReadonlyMap<string, string> {
  const body = text.slice(text.search(/^jobs:\n/m));
  const jobs = new Map<string, string>();
  for (const block of body.split(/^(?= {2}[a-z][\w-]*:$)/m).slice(1)) {
    const id = /^ {2}([a-z][\w-]*):$/m.exec(block)?.[1];
    assert.ok(id !== undefined, `a job block with no id: ${block.slice(0, 40)}`);
    jobs.set(id, block);
  }
  return jobs;
}

/**
 * The lines of a workflow that reach a secret or ask for a write token, comments left out: a merge queue group runs a
 * fork's code in the base repository's own context, so either would put that code in reach of them (T3386, T4590).
 */
function secretOrWriteLines(text: string): readonly string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .filter((line) => /\bsecrets\b/.test(line) || /:\s*write(-all)?\s*$/.test(line));
}

/** A job's step: what it runs (the `run:` command, else the action `uses:` names, its version left out) and its `if`. */
interface Step {
  readonly does: string;
  readonly when: string | undefined;
}

/** The steps of a job, in order, from its `steps:` list (six-space items, deeper lines belong to the step above). */
function stepsOf(job: string): readonly Step[] {
  const list = job.slice(job.search(/^ {4}steps:\n/m));
  return list
    .split(/^(?= {6}- )/m)
    .slice(1)
    .map((step) => {
      const does = /^ {6}- (?:id: \w+\n {8})?(?:run: (.+)|uses: ([^@\s]+)@)/m.exec(step);
      assert.ok(does !== null, `a step that neither runs nor uses: ${step.slice(0, 60)}`);
      return { does: does[1] ?? does[2] ?? '', when: /^ {8}if: (.+)$/m.exec(step)?.[1] };
    });
}

const SUMMARY = 'summary';
const CHANGES = 'changes';
const PUBLIC_ONLY = '    if: ${{ !github.event.repository.private }}\n';
const CODE = "${{ needs.changes.outputs.kind == 'code' }}";
const NOT_DESIGN = "${{ needs.changes.outputs.kind != 'design' }}";
const DOCS = "${{ needs.changes.outputs.kind == 'docs' }}";

describe('ci.yml', () => {
  const jobs = jobsOf(workflow);
  const checks = [...jobs.keys()].filter((id) => id !== SUMMARY);

  it('runs on each pull request, each merge queue group and each push to main, and by hand', () => {
    assert.match(
      workflow,
      /^on:\n(?: {2}#.*\n)* {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n(?: {2}#.*\n)* {2}merge_group:\n {4}types: \[checks_requested\]\n {2}workflow_dispatch:\n/m,
      'the merge queue waits on the same required check for each group it builds (T3386)',
    );
    assert.doesNotMatch(workflow, /pull_request_target/, 'a fork pull request must never run with secrets or a write token');
    assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
  });

  it('reaches no secret and asks for no write token, as a merge queue group runs fork code in the base repository', () => {
    assert.deepEqual(secretOrWriteLines(workflow), []);
    const risky = [
      '    permissions:',
      '      contents: write',
      'permissions: write-all',
      '          TOKEN: ${{ secrets.RELEASE_KEY }}',
      '    secrets: inherit',
      '      pull-requests: read # never write',
      '# secrets are named only in comments',
    ].join('\n');
    assert.deepEqual(secretOrWriteLines(risky), [
      '      contents: write',
      'permissions: write-all',
      '          TOKEN: ${{ secrets.RELEASE_KEY }}',
      '    secrets: inherit',
    ]);
  });

  it('skips every job while the repository is private, where minutes bill', () => {
    assert.ok(checks.length >= 5, checks.join(', '));
    for (const id of checks) {
      assert.ok(jobs.get(id)?.includes(PUBLIC_ONLY), `job ${id} lacks ${PUBLIC_ONLY.trim()}`);
    }
    assert.match(jobs.get(SUMMARY) ?? '', /^ {4}if: \$\{\{ always\(\) && !github\.event\.repository\.private \}\}$/m);
  });

  it('has one summary job that needs every other job and fails unless each passed', () => {
    const summary = jobs.get(SUMMARY) ?? '';
    assert.match(summary, /^ {4}name: every check passed$/m);
    const needs = /^ {4}needs: \[([^\]]+)\]$/m.exec(summary)?.[1]?.split(',').map((id) => id.trim());
    assert.deepEqual(needs, checks, 'the summary job needs every other job, in order');
    for (const result of ['failure', 'cancelled', 'skipped']) {
      assert.ok(summary.includes(`contains(needs.*.result, '${result}')`), `a needed job that ended ${result} fails the summary`);
    }
    assert.match(summary, /^ {8}run: exit 1$/m);
  });

  it('fails the summary unless every job of the run passed, each matrix leg alone', () => {
    const summary = jobs.get(SUMMARY) ?? '';
    const name = /^ {4}name: (.+)$/m.exec(summary)?.[1];
    assert.ok(name !== undefined);
    assert.match(summary, /^ {4}permissions:\n {6}actions: read\n {6}contents: read\n/m, "it lists the run's jobs with a read-only token");
    assert.ok(summary.includes(`        run: node tools/ci/every-check-cli.ts "${name}"\n`), 'it leaves out itself, by its own name');
    assert.match(summary, /^ {10}GH_TOKEN: \$\{\{ github\.token \}\}$/m);
    assert.ok(summary.indexOf('run: exit 1') < summary.indexOf('every-check-cli.ts'), 'the needs check runs first, so a failed job fails the summary with no API call');
  });

  it('fails a pull request that adds a dependency with a known advisory of any severity and scope', () => {
    const review = jobs.get('dependency-review') ?? '';
    assert.match(review, /^ {4}name: dependency review$/m);
    assert.match(review, /^ {6}- uses: actions\/dependency-review-action@[0-9a-f]{40} # v\d+\.\d+\.\d+$/m);
    assert.match(review, /^ {8}if: \$\{\{ github\.event_name == 'pull_request' \}\}$/m, 'a push or a run by hand has no pull request to compare, so only the step skips and the job passes');
    assert.match(review, /^ {10}fail-on-severity: low$/m);
    const scopes = /^ {10}fail-on-scopes: (.+)$/m.exec(review)?.[1]?.split(',').map((scope) => scope.trim());
    assert.deepEqual(scopes, ['runtime', 'development', 'unknown'], 'dev dependencies run at install and build time too');
    assert.doesNotMatch(review, /pull-requests: write/, 'it needs no write token, so a fork pull request runs it too');
  });

  it('stops every job after at most 20 minutes, so a hung test fails instead of holding the required check', () => {
    for (const [id, job] of jobs) {
      const minutes = /^ {4}timeout-minutes: (\d+)$/m.exec(job)?.[1];
      assert.ok(minutes !== undefined, `job ${id} sets no timeout-minutes, so GitHub's 6-hour default holds it`);
      assert.ok(Number(minutes) <= 20, `job ${id} waits ${minutes} minutes`);
    }
  });

  it("names the run's change kind first, from the whole history, for the jobs after it (T4617)", () => {
    assert.equal(checks[0], CHANGES, 'the summary needs it first, as every gated job does');
    const changes = jobs.get(CHANGES) ?? '';
    assert.match(changes, /^ {4}name: change kind$/m);
    assert.match(changes, /^ {4}outputs:\n {6}kind: \$\{\{ steps\.kind\.outputs\.kind \}\}\n {6}systems: \$\{\{ steps\.kind\.outputs\.systems \}\}$/m);
    assert.match(changes, /^ {10}fetch-depth: 0$/m, "a pull request's base must be in the checkout to compare with");
  });

  it("runs the base commit's classifier, never the change's own, and names a run with none code on every system (T4617)", () => {
    const changes = jobs.get(CHANGES) ?? '';
    assert.match(changes, /^ {10}BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.merge_group\.base_sha \|\| github\.event\.before \}\}$/m);
    assert.match(changes, /git worktree add --detach "\$RUNNER_TEMP\/base" "\$BASE_SHA"/);
    assert.match(changes, /^ {12}node "\$RUNNER_TEMP\/base\/tools\/ci\/change-kind-cli\.ts" --github$/m);
    assert.doesNotMatch(changes, /node tools\/ci\//, "the change's own tools/ci never runs here");
    const fallback = /printf 'kind=code\\nsystems=%s\\n' '(\[[^']*\])' >> "\$GITHUB_OUTPUT"/.exec(changes)?.[1];
    assert.ok(fallback !== undefined, 'a run with no base classifier is code');
    assert.equal(fallback, JSON.stringify(TEST_SYSTEMS));
  });

  it('skips steps, never a job, for a docs or design change, so the summary still fails any job that skipped', () => {
    for (const [id, job] of jobs) {
      const jobIf = /^ {4}if: (.+)$/m.exec(job)?.[1] ?? '';
      assert.doesNotMatch(jobIf, /needs\.changes/, `job ${id} skips itself on the change kind`);
    }
    for (const id of ['coverage', 'test']) {
      assert.match(jobs.get(id) ?? '', /^ {4}needs: changes$/m, `job ${id} reads the change kind`);
    }
    assert.doesNotMatch(workflow, /^ {2}(?:push|pull_request|merge_group):\n(?: {4}.*\n)* {4}paths(?:-ignore)?:/m, 'a skipped workflow never reports the required check');
  });

  it('runs no coverage step for a docs or design change, which has no code to cover', () => {
    const steps = stepsOf(jobs.get('coverage') ?? '');
    assert.ok(steps.length >= 4, steps.map((step) => step.does).join(', '));
    for (const step of steps) {
      assert.equal(step.when, CODE, `coverage runs ${step.does} for a change with no code`);
    }
  });

  it('tests a code change on every OS, and a docs or design change on ubuntu alone with only its own steps', () => {
    const test = jobs.get('test') ?? '';
    assert.match(test, /^ {8}os: \$\{\{ fromJSON\(needs\.changes\.outputs\.systems\) \}\}$/m, 'the runners change-kind-cli.ts names (testSystems)');
    assert.deepEqual(stepsOf(test), [
      { does: 'actions/checkout', when: undefined },
      { does: 'actions/setup-node', when: undefined },
      { does: 'npm ci --ignore-scripts', when: NOT_DESIGN },
      { does: 'npm run typecheck', when: CODE },
      { does: 'npm run build', when: NOT_DESIGN },
      { does: 'npm test', when: CODE },
      { does: 'node --test "tools/docs/*.test.ts" tools/ci/security-workflows.test.ts', when: DOCS },
      { does: 'node tools/ci/dist-smoke-cli.ts', when: CODE },
      { does: 'node tools/ci/fresh-install-cli.ts', when: CODE },
      { does: 'node tools/docs/images-cli.ts --check', when: NOT_DESIGN },
      { does: 'node tools/docs/configuration-cli.ts --check', when: NOT_DESIGN },
      { does: 'node tools/docs/parity-cli.ts --check', when: NOT_DESIGN },
      { does: 'node tools/ci/boundaries-cli.ts', when: CODE },
      { does: 'node tools/ci/provider-words-cli.ts', when: CODE },
      { does: 'node tools/docs/doc-check-cli.ts', when: undefined },
    ]);
  });

  it('runs the commit checks on every change, docs and design included', () => {
    for (const id of ['gates', 'size-rule', 'commit-subjects']) {
      const job = jobs.get(id) ?? '';
      assert.doesNotMatch(job, /needs\.changes/, `job ${id} reads the change kind`);
      assert.ok(stepsOf(job).every((step) => step.when === undefined), `job ${id} skips a step`);
    }
  });

  it('builds the plugin before each job runs the specs, which load the built dist (T4355)', () => {
    for (const [id, specs] of [['coverage', '- run: node tools/ci/coverage-cli.ts'], ['test', '- run: npm test']] as const) {
      const job = jobs.get(id) ?? '';
      const build = job.indexOf('- run: npm run build\n');
      assert.ok(build >= 0 && build < job.indexOf(specs), `job ${id} runs the specs before the build`);
    }
  });
});
