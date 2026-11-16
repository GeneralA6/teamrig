import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CliHarness, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { WakeAsks } from '../wake/asks.ts';
import { EXIT } from './runtime.ts';

async function inboxOf(kit: CliHarness, session: string): Promise<string[]> {
  const read = await kit.run(['inbox', 'read', '--session', session]);
  return read.stdout.filter((line) => line.startsWith('- '));
}

/** A team whose T1, alpha's, waits on the lead's approval of its push. */
async function asking(kit = new CliHarness()): Promise<CliHarness> {
  await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p1', '--session', 'alpha']);
  const set = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'approval:lead', '--note', 'branch t1, the CLI fix', '--session', 'alpha']);
  assert.equal(set.code, EXIT.ok, set.stderr.join('\n'));
  return kit;
}

describe("runCli: approve, the lead's answer to an approval wait (T684)", () => {
  it("approves, tells the task's owner to push or merge, and check flags the task READY", async () => {
    const kit = await asking();
    const approved = await kit.run(['approve', 'T1', '--note', 'tests green, small commits', '--session', 'lead']);
    assert.equal(approved.code, EXIT.ok, approved.stderr.join('\n'));
    assert.match(approved.stdout[0] ?? '', /^APPROVED T1 .*\(waiting: approval lead · lead approved; branch t1, the CLI fix\)/);
    assert.deepEqual(await inboxOf(kit, 'alpha'), ['- 2030-01-08 10:00 UTC lead: lead approved T1: tests green, small commits; push or merge it now, then set its next status']);
    const checked = await kit.run(['check', '--all', '--session', 'alpha']);
    assert.match(checked.stdout.join('\n'), /READY \(lead approved it; push or merge it, then set its next status\) T1 /);
  });

  it('declines with --decline, telling the owner why', async () => {
    const kit = await asking();
    const declined = await kit.run(['approve', 'T1', '--decline', '--note', 'no tests for the new flag', '--session', 'lead']);
    assert.equal(declined.code, EXIT.ok, declined.stderr.join('\n'));
    assert.match(declined.stdout[0] ?? '', /^DECLINED T1 /);
    assert.deepEqual(await inboxOf(kit, 'alpha'), [
      '- 2030-01-08 10:00 UTC lead: lead declined T1: no tests for the new flag; set it in-progress, fix that, then ask again (--status waiting --waits approval:lead)',
    ]);
  });

  it("is the lead's alone, needs a note, and tells nobody when refused", async () => {
    const kit = await asking();
    const own = await kit.run(['approve', 'T1', '--note', 'mine', '--session', 'alpha']);
    assert.notEqual(own.code, EXIT.ok);
    assert.match([...own.stdout, ...own.stderr].join('\n'), /only the lead \(lead\) answers an approval/);
    const bare = await kit.run(['approve', 'T1', '--session', 'lead']);
    assert.notEqual(bare.code, EXIT.ok);
    assert.match([...bare.stdout, ...bare.stderr].join('\n'), /an answer needs --note/);
    assert.deepEqual(await inboxOf(kit, 'alpha'), []);
  });
});

describe('runCli: approve by a sub-lead (T781)', () => {
  it("lets a sub-lead answer its member's approval wait, telling the member, where the lead it does not wait on is refused", async () => {
    const kit = new CliHarness({ sessions: ['lead', 'alpha', 'bravo'], roles: { lead: 'lead' }, leads: { alpha: ['bravo'] } });
    await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p1', '--session', 'bravo']);
    const set = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'approval:alpha', '--note', 'branch t1, the CLI fix', '--session', 'bravo']);
    assert.equal(set.code, EXIT.ok, set.stderr.join('\n'));
    const byLead = await kit.run(['approve', 'T1', '--note', 'ok', '--session', 'lead']);
    assert.notEqual(byLead.code, EXIT.ok);
    assert.match([...byLead.stdout, ...byLead.stderr].join('\n'), /T1 does not wait on the lead's approval \(approval:lead\)/);
    const approved = await kit.run(['approve', 'T1', '--note', 'tests green', '--session', 'alpha']);
    assert.equal(approved.code, EXIT.ok, approved.stderr.join('\n'));
    assert.deepEqual(await inboxOf(kit, 'bravo'), ['- 2030-01-08 10:00 UTC alpha: alpha approved T1: tests green; push or merge it now, then set its next status']);
  });
});

describe('runCli: approve by the security reviewer (T828)', () => {
  const team = { sessions: ['lead', 'alpha', 'security'], roles: { lead: 'lead', securityReviewer: 'security' } };

  it("lets the security reviewer answer an approval wait on another's task, telling the owner", async () => {
    const kit = new CliHarness(team);
    await kit.run(['add', '--title', 'Ship the gate', '--description', 'what and why', '--priority', 'p1', '--session', 'alpha']);
    const set = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'approval:security', '--note', 'review hold r1', '--session', 'alpha']);
    assert.equal(set.code, EXIT.ok, set.stderr.join('\n'));
    const approved = await kit.run(['approve', 'T1', '--note', 'no secrets in the diff', '--session', 'security']);
    assert.equal(approved.code, EXIT.ok, approved.stderr.join('\n'));
    assert.deepEqual(await inboxOf(kit, 'alpha'), ['- 2030-01-08 10:00 UTC security: security approved T1: no secrets in the diff; push or merge it now, then set its next status']);
  });

  it('refuses the reviewer a decision wait and an approval of its own task', async () => {
    const kit = new CliHarness(team);
    await kit.run(['add', '--title', 'Ship the gate', '--description', 'what and why', '--priority', 'p1', '--session', 'alpha']);
    await kit.run(['add', '--title', 'Ship the audit', '--description', 'what and why', '--priority', 'p1', '--session', 'security']);
    const decision = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'decision:security', '--note', 'which way', '--session', 'alpha']);
    assert.notEqual(decision.code, EXIT.ok);
    assert.match([...decision.stdout, ...decision.stderr].join('\n'), /decision security: decision waits are for the lead \(lead\) and owner/);
    const own = await kit.run(['set', 'T2', '--status', 'waiting', '--waits', 'approval:security', '--note', 'review hold r2', '--session', 'security']);
    assert.notEqual(own.code, EXIT.ok);
    assert.match([...own.stdout, ...own.stderr].join('\n'), /approval security: approval waits are for the lead \(lead\) and owner/);
  });
});

describe('runCli: approve wakes the waiting owner (T1422)', () => {
  const ASKS = join(TEAM_HOME, 'state', 'wake-asks');

  async function asksOf(kit: CliHarness): Promise<(string | undefined)[]> {
    return (await new WakeAsks(kit.files, ASKS).read('alpha')).map((stored) => stored.ask?.text);
  }

  it('posts the approval as a wake ask beside the inbox line, so an idle tab wakes on it', async () => {
    const kit = await asking();
    const approved = await kit.run(['approve', 'T1', '--note', 'tests green', '--session', 'lead']);
    assert.equal(approved.code, EXIT.ok, approved.stderr.join('\n'));
    assert.deepEqual(await asksOf(kit), ['lead approved T1: tests green; push or merge it now, then set its next status']);
  });

  it('posts a decline as a wake ask too', async () => {
    const kit = await asking();
    const declined = await kit.run(['approve', 'T1', '--decline', '--note', 'no tests', '--session', 'lead']);
    assert.equal(declined.code, EXIT.ok, declined.stderr.join('\n'));
    assert.deepEqual(await asksOf(kit), ['lead declined T1: no tests; set it in-progress, fix that, then ask again (--status waiting --waits approval:lead)']);
  });

  it('posts no ask in a team with its wakes off, the line still told', async () => {
    const kit = await asking(new CliHarness({ ...TEAM, wake: { enabled: false } }));
    const approved = await kit.run(['approve', 'T1', '--note', 'tests green', '--session', 'lead']);
    assert.equal(approved.code, EXIT.ok, approved.stderr.join('\n'));
    assert.deepEqual(await asksOf(kit), []);
    assert.equal((await inboxOf(kit, 'alpha')).length, 1);
  });

  it('warns with the by-hand wake when the ask cannot be posted, the approval and line kept', async () => {
    const kit = await asking();
    const files = new FaultyFiles(kit.files).fail('createExclusive', join(ASKS, 'alpha', `${kit.clock.now()}-0.json`), systemError('EIO'));
    const approved = await kit.run(['approve', 'T1', '--note', 'tests green', '--session', 'lead'], { files });
    assert.equal(approved.code, EXIT.ok, approved.stderr.join('\n'));
    assert.match(approved.stderr.join('\n'), /WARN alpha has the line, but its idle tab is not woken for it \(.*EIO.*\): teamrig inbox add --to alpha --text "\.\.\." --wake now/);
    assert.equal((await inboxOf(kit, 'alpha')).length, 1);
  });
});

describe('runCli: a set after an approval (T3207)', () => {
  it('refuses a set that would drop the approval, keeps it through update --note, and drops it with --drop-approval', async () => {
    const kit = await asking();
    const approved = await kit.run(['approve', 'T1', '--note', 'merge 4501e5b7a', '--session', 'lead']);
    assert.equal(approved.code, EXIT.ok, approved.stderr.join('\n'));
    const progress = await kit.run(['set', 'T1', '--status', 'in-progress', '--note', 'merge queued', '--session', 'alpha']);
    assert.notEqual(progress.code, EXIT.ok);
    assert.match([...progress.stdout, ...progress.stderr].join('\n'), /T1 holds lead's approval of 4501e5b7a, and setting it in-progress drops it/);
    const noted = await kit.run(['update', 'T1', '--note', 'merge queued', '--session', 'alpha']);
    assert.equal(noted.code, EXIT.ok, noted.stderr.join('\n'));
    const checked = await kit.run(['check', '--all', '--session', 'alpha']);
    assert.match(checked.stdout.join('\n'), /READY \(lead approved it; push or merge it, then set its next status\) T1 /);
    const reask = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'approval:lead', '--note', 'new head 9f8e7d6c1', '--drop-approval', '--session', 'alpha']);
    assert.equal(reask.code, EXIT.ok, reask.stderr.join('\n'));
    const after = await kit.run(['check', '--all', '--session', 'alpha']);
    assert.doesNotMatch(after.stdout.join('\n'), /READY \(lead approved it/);
  });
});
