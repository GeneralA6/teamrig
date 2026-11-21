import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { profileFor, readProfiles } from '../ship/repos.ts';

const workflow = readFileSync(new URL('../../.github/workflows/release-merge.yml', import.meta.url), 'utf8');

/** Each job's text, from its `  <id>:` line to the next job's. */
const jobs: ReadonlyMap<string, string> = new Map(
  (workflow.split(/^jobs:\n/m)[1] ?? '')
    .split(/^(?= {2}[\w-]+:$)/m)
    .map((block) => [/^ {2}([\w-]+):$/m.exec(block)?.[1] ?? '', block]),
);
const job = (id: string): string => {
  const text = jobs.get(id);
  assert.ok(text !== undefined, `release-merge.yml has the job ${id}`);
  return text;
};

const permissionsOf = (text: string): readonly string[] => [...(/^ {4}permissions:\n((?: {6}.+\n)+)/m.exec(text)?.[1] ?? '').matchAll(/^ {6}(.+)$/gm)].map((match) => match[1] ?? '');

/** The job's `if:` folded into one line. */
const conditionOf = (text: string): string => (/^ {4}if: >-\n((?: {6}.+\n)+)/m.exec(text)?.[1] ?? '').replace(/\s+/g, ' ').trim();

const release = profileFor(readProfiles(), 'teamrig/teamrig').release;

describe('release-merge.yml', () => {
  it('runs when a ci run ends, one at a time, never cancelled, with no token by default', () => {
    assert.match(workflow, /^on:\n(?: {2}#.*\n)* {2}workflow_run:\n {4}workflows: \[ci\]\n {4}types: \[completed\]\n/m);
    assert.match(workflow, /^permissions: \{\}\n/m);
    assert.match(workflow, /^concurrency:\n {2}group: release-merge\n {2}cancel-in-progress: false\n/m);
  });

  it("narrows both jobs to release.yml's passed dispatch of ci on this repository's release branch, inert until the App exists", () => {
    assert.ok(release !== null);
    for (const id of ['gate', 'merge']) {
      const condition = conditionOf(job(id));
      for (const clause of [
        "vars.RELEASE_APP_ID != ''",
        "github.event.workflow_run.event == 'workflow_dispatch'",
        "github.event.workflow_run.conclusion == 'success'",
        'github.event.workflow_run.head_repository.full_name == github.repository',
        `github.event.workflow_run.head_branch == '${release.head}'`,
      ]) {
        assert.ok(condition.includes(clause), `${id}: ${clause}`);
      }
      assert.doesNotMatch(condition, /\|\|/, `${id}: every clause must hold`);
    }
    assert.ok(conditionOf(job('merge')).startsWith("needs.gate.outputs.pass == 'true' && "));
  });

  it('gates with a read-only token and no environment, so no secret reaches the gate', () => {
    const gate = job('gate');
    assert.deepEqual(permissionsOf(gate), ['actions: read', 'checks: read', 'contents: read', 'pull-requests: read', 'statuses: read']);
    assert.doesNotMatch(gate, /environment:|secrets\./);
  });

  it("merges in the release-merge environment, whose secret is the App's key, with a code-only job token", () => {
    const merge = job('merge');
    assert.match(merge, /^ {4}environment: release-merge$/m);
    assert.deepEqual(permissionsOf(merge), ['contents: read']);
    assert.equal(workflow.match(/secrets\./g)?.length, 1);
    assert.match(merge, /^ {10}APP_KEY: \$\{\{ secrets\.RELEASE_APP_KEY \}\}$/m);
  });

  it('puts no event value in a run line, caches nothing, installs no package and keeps no checkout credentials', () => {
    for (const [line] of workflow.matchAll(/^ *run: .*$/gm)) assert.doesNotMatch(line, /\$\{\{/, line);
    assert.doesNotMatch(workflow, /actions\/cache|download-artifact|cache:|npm (ci|install)/);
    assert.equal(workflow.match(/actions\/checkout@/g)?.length, workflow.match(/persist-credentials: false/g)?.length);
  });

  it('stops each job within 10 minutes', () => {
    for (const [id, text] of jobs) {
      if (id === '') continue;
      assert.match(text, /^ {4}timeout-minutes: 10$/m, id);
    }
  });
});
