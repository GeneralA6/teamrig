import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness, TEAM } from '../testing/cli-harness.ts';
import { hostTelling, NO_SESSION_HOST } from '../testing/host.ts';
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

  it("refuses an audit and a lead-only write as another session", async () => {
    const kit = await alphaTab();
    const refused = (session: string) => ["REFUSED this tab is alpha's: a session runs teamrig's writes only as itself, not as " + session];
    assert.deepEqual((await kit.run(['audit', 'T1', '--file', 'step.ps1', '--session', 'bravo'], { env: TAB })).stdout, refused('bravo'));
    assert.deepEqual((await kit.run(['burst', 'end', '--reason', 'done', '--session', 'lead'], { env: TAB })).stdout, refused('lead'));
  });

  it("leaves a re-bind to the tab's bind-once rule: a tool call cannot move the tab, the person can, and writes follow it", async () => {
    const kit = await alphaTab();
    const toolCall = await kit.run(['inbox', 'read', '--session', 'lead'], { env: { ...TAB, CLAUDECODE: '1' } });
    assert.equal(toolCall.code, EXIT.refused);
    assert.match(toolCall.stdout[0] ?? '', /^REFUSED teamrig inbox read --session lead would make this tab, the alpha session, the lead session: /);
    assert.equal((await kit.run(['approve', 'T1', '--note', 'ok', '--session', 'lead'], { env: TAB })).code, EXIT.refused, 'still bound to alpha');
    assert.equal((await kit.run(['inbox', 'read', '--session', 'lead'], { env: TAB })).code, EXIT.ok, 'typed by the person');
    const approved = await kit.run(['approve', 'T1', '--note', 'ok', '--session', 'lead'], { env: TAB });
    assert.equal(approved.code, EXIT.ok, approved.stdout.join('\n'));
    assert.deepEqual((await kit.run(['update', 'T1', '--note', 'mine', '--session', 'alpha'], { env: TAB })).stdout, [
      "REFUSED this tab is lead's: a session runs teamrig's writes only as itself, not as alpha",
    ]);
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
    assert.equal((await kit.run(['approve', 'T1', '--note', 'ok', '--session', 'lead'], { env: fresh })).code, EXIT.refused, 'and then it is bravo\'s');
  });

  it('takes the tab from the host: an id it tells, bound to another session, is refused, and where it tells none nothing is checked', async () => {
    const kit = await alphaTab();
    const told = { host: hostTelling({ sessionId: TAB.CLAUDE_CODE_SESSION_ID }) };
    assert.deepEqual((await kit.run(['approve', 'T1', '--note', 'ok', '--session', 'lead'], told)).stdout, [
      "REFUSED this tab is alpha's: a session runs teamrig's writes only as itself, not as lead",
    ]);
    assert.equal((await kit.run(['update', 'T1', '--note', 'mine', '--session', 'alpha'], told)).code, EXIT.ok, 'its own session');
    const untold = await kit.run(['approve', 'T1', '--note', 'ok', '--session', 'lead'], { env: TAB, host: NO_SESSION_HOST });
    assert.equal(untold.code, EXIT.ok, untold.stdout.join('\n'));
  });

  it('binds a tab by the id its host tells, with no variable of a host set', async () => {
    const kit = await alphaTab();
    const fresh = { host: hostTelling({ sessionId: '9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff' }) };
    assert.equal((await kit.run(['inbox', 'read', '--session', 'bravo'], fresh)).code, EXIT.ok, 'its first read binds it');
    assert.deepEqual((await kit.run(['approve', 'T1', '--note', 'ok', '--session', 'lead'], fresh)).stdout, [
      "REFUSED this tab is bravo's: a session runs teamrig's writes only as itself, not as lead",
    ]);
  });

  it('leaves a tab with no team found, or a team config that does not load, to the command\'s own refusal', async () => {
    for (const [what, kit] of [
      ['no team', new CliHarness(TEAM, null)],
      ['a config that does not load', new CliHarness('{ not json')],
    ] as const) {
      const run = await kit.run(['approve', 'T1', '--note', 'ok', '--session', 'lead'], { env: TAB });
      assert.notEqual(run.code, EXIT.ok, what);
      assert.doesNotMatch([...run.stdout, ...run.stderr].join('\n'), /this tab is/, what);
    }
  });
});
