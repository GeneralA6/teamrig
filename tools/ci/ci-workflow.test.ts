import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

const SUMMARY = 'summary';
const PUBLIC_ONLY = '    if: ${{ !github.event.repository.private }}\n';

describe('ci.yml', () => {
  const jobs = jobsOf(workflow);
  const checks = [...jobs.keys()].filter((id) => id !== SUMMARY);

  it('runs on each pull request and each push to main, and by hand', () => {
    assert.match(workflow, /^on:\n(?: {2}#.*\n)* {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n {2}workflow_dispatch:\n/m);
    assert.doesNotMatch(workflow, /pull_request_target/, 'a fork pull request must never run with secrets or a write token');
    assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
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
});
