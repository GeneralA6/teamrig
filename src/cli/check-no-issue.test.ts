import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { formatConfig } from '../config/load.ts';
import { CliHarness, CONFIG_PATH, TEAM } from '../testing/cli-harness.ts';
import { FakeGh } from '../testing/fake-gh.ts';
import { EXIT } from './runtime.ts';

const OPEN_TEAM: JsonRecord = { ...TEAM, github: { repos: ['acme/web'] } };
const AT_ADD_TEAM: JsonRecord = { ...TEAM, github: { repos: ['acme/web'], issueAtAdd: 'acme/web' } };
const AS_LEAD = { env: { TEAMRIG_SESSION: 'lead' }, gh: new FakeGh() };

function add(title: string, ...more: string[]): string[] {
  return ['add', '--title', title, '--description', `${title}: what and why`, '--priority', 'p2', ...more];
}

describe('teamrig check with github.issueAtAdd set', () => {
  it('flags NO-ISSUE on the task left with no issue, and not on one linked or kept local', async () => {
    const kit = new CliHarness(OPEN_TEAM);
    const unlinked = await kit.run(add('Unlinked task'), AS_LEAD);
    await kit.files.write(CONFIG_PATH, formatConfig(AT_ADD_TEAM));
    const steps = [
      unlinked,
      await kit.run(add('Linked task', '--ref', 'gh:acme/web#5'), AS_LEAD),
      await kit.run(add('Local task', '--local', 'names an unfixed weakness'), AS_LEAD),
    ];
    assert.deepEqual(steps.map((step) => step.code), [EXIT.ok, EXIT.ok, EXIT.ok], steps.flatMap((step) => [...step.stdout, ...step.stderr]).join('\n'));
    const result = await kit.run(['check', '--all'], AS_LEAD);
    const flagged = result.stdout.filter((line) => line.includes('NO-ISSUE'));
    assert.equal(flagged.length, 1, result.stdout.join('\n'));
    assert.match(flagged[0] ?? '', /^NO-ISSUE \(no issue in acme\/web and no reason to stay local: .*update T1 --ref .*\) T1 open, .*\| Unlinked task$/u);
  });
});
