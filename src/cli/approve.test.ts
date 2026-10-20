import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

async function inboxOf(kit: CliHarness, session: string): Promise<string[]> {
  const read = await kit.run(['inbox', 'read', '--session', session]);
  return read.stdout.filter((line) => line.startsWith('- '));
}

/** A team whose T1, alpha's, waits on the lead's approval of its push. */
async function asking(): Promise<CliHarness> {
  const kit = new CliHarness();
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
