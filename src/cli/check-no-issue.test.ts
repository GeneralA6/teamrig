import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { CliHarness, TEAM } from '../testing/cli-harness.ts';
import { FakeGh } from '../testing/fake-gh.ts';
import { EXIT } from './runtime.ts';

const AT_ADD_TEAM: JsonRecord = { ...TEAM, github: { repos: ['acme/web'], issueAtAdd: 'acme/web' } };
const AS_LEAD = { env: { TEAMRIG_SESSION: 'lead' }, gh: new FakeGh() };
const GITHUB_OFF = { env: { TEAMRIG_SESSION: 'lead', TEAMRIG_GITHUB: 'off' }, gh: new FakeGh() };

function add(title: string, ...more: string[]): string[] {
  return ['add', '--title', title, '--description', `${title}: what and why`, '--priority', 'p2', ...more];
}

describe('teamrig check with github.issueAtAdd set', () => {
  it('flags NO-ISSUE on the task left with no issue, and not on one linked or kept local', async () => {
    const kit = new CliHarness(AT_ADD_TEAM);
    const steps = [
      await kit.run(add('Linked task', '--ref', 'gh:acme/web#5'), AS_LEAD),
      await kit.run(add('Local task', '--local', 'names an unfixed weakness'), AS_LEAD),
      await kit.run(add('Unlinked task', '--issue', 'A public title', '--issue-body', 'A public body.'), GITHUB_OFF),
    ];
    assert.deepEqual(steps.map((step) => step.code), [EXIT.ok, EXIT.ok, EXIT.ok], steps.flatMap((step) => [...step.stdout, ...step.stderr]).join('\n'));
    const result = await kit.run(['check', '--all'], AS_LEAD);
    const flagged = result.stdout.filter((line) => line.includes('NO-ISSUE'));
    assert.equal(flagged.length, 1, result.stdout.join('\n'));
    assert.match(flagged[0] ?? '', /^NO-ISSUE \(no issue in acme\/web and no reason to stay local: .*update T3 --ref .*\) T3 open, .*\| Unlinked task$/u);
  });
});
