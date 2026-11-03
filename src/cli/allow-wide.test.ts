import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import { CliHarness, APP, USER_HOME, type RunOptions } from '../testing/cli-harness.ts';

/** A value a rule can hold; no output may carry it. Joined, so no source line holds a URL the secret redactor catches. */
const HELD_VALUE = ['postgres://user:', 'hunter22', '@db.example.net'].join('');
const USER = join(USER_HOME, '.claude', 'settings.json');
const SHARED = join(APP, '.claude', 'settings.json');
const TREE = join(APP, '.claude', 'worktrees', 'fix', '.claude', 'settings.local.json');
const OPTIONS: RunOptions = { platform: 'linux' };
const FLAG =
  "WARN allow-wide 4 local allow rule(s) in 3 settings file(s) approve a whole tool or program, so auto mode's classifier never sees those calls, or hold a credential saved with an approved command (Bash wide 2, Bash credential 1, Read wide 1); `teamrig permissions trim` previews their removal, and the owner runs it with --yes";

/** Wide rules and a credential off the keep-list in the user settings, the committed project settings and a Claude Code worktree's. */
async function withWideRules(): Promise<CliHarness> {
  const kit = new CliHarness();
  await kit.files.write(USER, formatConfig({ permissions: { allow: ['Bash', 'Bash(kubectl get:*)', `Bash(psql ${HELD_VALUE})`] } }));
  await kit.files.write(SHARED, formatConfig({ permissions: { allow: ['Read(//c/**)'] } }));
  await kit.files.write(TREE, formatConfig({ permissions: { allow: ['Bash(node:*)', 'WebSearch'] } }));
  return kit;
}

function assertNoSecret(lines: readonly string[]): void {
  assert.ok(lines.every((line) => !line.includes('hunter22')));
}

describe('the allow-wide flag', () => {
  it('is a doctor finding counted by class, the committed settings and worktrees included', async () => {
    const doctor = await (await withWideRules()).run(['doctor'], OPTIONS);
    assert.ok(doctor.stdout.includes(FLAG), doctor.stdout.join('\n'));
    assertNoSecret(doctor.stdout);
  });

  it("is a warning no session owns in check, which the lead's start shows and another session's does not", async () => {
    const kit = await withWideRules();
    const row = `from the permissions check [permissions.keepAllow]: ${FLAG}`;
    const check = await kit.run(['check', '--all', '--session', 'lead'], OPTIONS);
    assert.ok(check.stdout.includes(row), check.stdout.join('\n'));
    const lead = await kit.run(['start', '--session', 'lead', '--all'], OPTIONS);
    assert.ok(lead.stdout.includes(row), lead.stdout.join('\n'));
    const alpha = await kit.run(['start', '--session', 'alpha', '--all'], OPTIONS);
    assert.ok(!alpha.stdout.some((line) => line.includes('allow-wide')), alpha.stdout.join('\n'));
    assertNoSecret([...check.stdout, ...lead.stdout, ...alpha.stdout]);
  });

  it("counts an exact rule that holds one of the team's own secret shapes", async () => {
    const kit = new CliHarness({ sessions: ['lead'], roles: { lead: 'lead' }, register: { secretPatterns: ['hush-[0-9]+'] } });
    await kit.files.write(USER, formatConfig({ permissions: { allow: ['Bash(deploy --token hush-42)', 'Bash(git log)'] } }));
    const doctor = await kit.run(['doctor'], OPTIONS);
    assert.ok(
      doctor.stdout.includes(
        "WARN allow-wide 1 local allow rule(s) in 1 settings file(s) approve a whole tool or program, so auto mode's classifier never sees those calls, or hold a credential saved with an approved command (Bash credential 1); `teamrig permissions trim` previews their removal, and the owner runs it with --yes",
      ),
      doctor.stdout.join('\n'),
    );
    assert.ok(doctor.stdout.every((line) => !line.includes('hush-42')));
  });

  it('is quiet once no file holds a wide or credential rule off the keep-list', async () => {
    const kit = new CliHarness();
    await kit.files.write(USER, formatConfig({ permissions: { allow: ['Bash(git log)', 'Bash(kubectl get:*)', 'WebSearch'] } }));
    const doctor = await kit.run(['doctor'], OPTIONS);
    assert.ok(!doctor.stdout.some((line) => line.includes('allow-wide')), doctor.stdout.join('\n'));
  });
});
