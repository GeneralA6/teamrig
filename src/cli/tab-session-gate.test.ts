import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness, TEAM } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

/** A Claude Code tab, by its session id; `inbox read --session <id>` binds it to that session. */
const TAB = { CLAUDE_CODE_SESSION_ID: '9f8e7d6c-1111-2222-3333-444455556666' };

/** A team whose T1, alpha's, waits on the lead's approval, with a tab bound to alpha. */
async function alphaTab(kit = new CliHarness()): Promise<CliHarness> {
  await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p1', '--session', 'alpha']);
  const set = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'approval:lead', '--note', 'branch t1', '--session', 'alpha']);
  assert.equal(set.code, EXIT.ok, set.stderr.join('\n'));
  assert.equal((await kit.run(['inbox', 'read', '--session', 'alpha'], { env: TAB })).code, EXIT.ok);
  return kit;
}

/** T1's line in the register listing. */
async function t1Of(kit: CliHarness): Promise<string> {
  return (await kit.run(['show', 'T1'])).stdout[0] ?? '';
}

// A tab bound to a session runs every teamrig write as that session alone, whatever --session or $TEAMRIG_SESSION say.
describe("runCli: a write runs only as its tab's own session (T3082)", () => {
  it('refuses an approve naming another session, by --session or $TEAMRIG_SESSION, and leaves the task as it was', async () => {
    const kit = await alphaTab();
    const before = await t1Of(kit);
    const flag = await kit.run(['approve', 'T1', '--note', 'looks fine', '--session', 'lead'], { env: TAB });
    assert.deepEqual(flag, { code: EXIT.refused, stdout: ["REFUSED this tab is alpha's: a session runs teamrig's writes only as itself, not as lead"], stderr: [] });
    const env = await kit.run(['approve', 'T1', '--note', 'looks fine'], { env: { ...TAB, TEAMRIG_SESSION: 'lead' } });
    assert.equal(env.code, EXIT.refused);
    assert.equal(await t1Of(kit), before, 'T1 still waits, unapproved');
  });

  it("refuses an audit, a lead-only write and a re-bind of the tab as another session", async () => {
    const kit = await alphaTab();
    const refused = (session: string) => ["REFUSED this tab is alpha's: a session runs teamrig's writes only as itself, not as " + session];
    assert.deepEqual((await kit.run(['audit', 'T1', '--file', 'step.ps1', '--session', 'bravo'], { env: TAB })).stdout, refused('bravo'));
    assert.deepEqual((await kit.run(['burst', 'end', '--reason', 'done', '--session', 'lead'], { env: TAB })).stdout, refused('lead'));
    assert.deepEqual((await kit.run(['inbox', 'read', '--session', 'lead'], { env: TAB })).stdout, refused('lead'), "the tab stays alpha's");
    assert.equal((await kit.run(['approve', 'T1', '--note', 'ok', '--session', 'lead'], { env: TAB })).code, EXIT.refused, 'still bound to alpha');
  });

  it("lets the tab write as its own session, by id or name, and read as any session", async () => {
    const kit = await alphaTab(new CliHarness({ ...TEAM, names: { alpha: 'ace' } }));
    assert.equal((await kit.run(['inbox', 'add', '--to', 'lead', '--text', 'T1 is ready', '--session', 'ace'], { env: TAB })).code, EXIT.ok);
    assert.equal((await kit.run(['update', 'T1', '--note', 'ready', '--session', 'alpha'], { env: TAB })).code, EXIT.ok);
    assert.equal((await kit.run(['list', '--session', 'bravo'], { env: TAB })).code, EXIT.ok, 'a read names any session');
  });

  it("checks nothing outside a Claude Code tab or in a tab bound to no session yet", async () => {
    const kit = await alphaTab();
    const approved = await kit.run(['approve', 'T1', '--note', 'tests green', '--session', 'lead']);
    assert.equal(approved.code, EXIT.ok, approved.stdout.join('\n'));
    const fresh = { CLAUDE_CODE_SESSION_ID: '9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff' };
    assert.equal((await kit.run(['inbox', 'read', '--session', 'bravo'], { env: fresh })).code, EXIT.ok, 'its first read binds it');
    assert.equal((await kit.run(['inbox', 'read', '--session', 'lead'], { env: fresh })).code, EXIT.refused, 'and then it is bravo\'s');
  });
});
