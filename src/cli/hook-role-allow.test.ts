import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isRecord, recordField, type JsonRecord } from '../core/guards.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { EXIT } from './runtime.ts';

const ANSWERS_LOG = join(TEAM_HOME, 'state', 'prompt-answers.jsonl');
const MARKS = join(TEAM_HOME, 'state', 'inbox-marks.jsonl');
const HOOK = ['hook', 'route-allow'];
const NOTHING = { code: EXIT.ok, stdout: [], stderr: [] };
const ALPHA = { TEAMRIG_SESSION: 'alpha' };
/** A close with no --session, which no role call is (T2984). */
const UNNAMED = 'teamrig issue close acme/web#7 --comment "Fixed in #8; thanks!"';
const CLOSE = `${UNNAMED} --session alpha`;
/** A token shape the secret guard knows, built here so no token sits in the source. */
const TOKEN = ['gh', 'p_', 'a1'.repeat(18)].join('');

/** A team whose `github` role gives alpha both issue commands on acme/web. */
function roleTeam(extra: JsonRecord = {}): JsonRecord {
  return {
    ...TEAM,
    github: { repos: ['acme/web'] },
    serviceRoles: { github: { holders: ['alpha'], commands: ['issue close', 'issue comment'] } },
    ...extra,
  };
}

function call(command: string, fields: JsonRecord = {}): string {
  return JSON.stringify({ hook_event_name: 'PreToolUse', session_id: CLAUDE_SESSION, cwd: APP, tool_name: 'Bash', tool_input: { command }, ...fields });
}

/** Records that this test's Claude Code session read `area`'s inbox. */
async function mark(kit: CliHarness, area: string, claudeSession: string = CLAUDE_SESSION): Promise<void> {
  const record = { v: 1, area, line: 0, at: '2030-01-08T09:00:00.000Z', claudeSession, lastLineHash: null };
  await kit.files.append(MARKS, `${JSON.stringify(record)}\n`);
}

/** A harness with the role team, its tab bound to alpha. */
async function boundKit(extra: JsonRecord = {}): Promise<CliHarness> {
  const kit = new CliHarness(roleTeam(extra));
  await mark(kit, 'alpha');
  return kit;
}

function decisionOf(result: CliResult): unknown {
  const [line] = result.stdout;
  const parsed: unknown = line === undefined ? undefined : JSON.parse(line);
  const output = isRecord(parsed) ? recordField(parsed, 'hookSpecificOutput') : undefined;
  return output?.['permissionDecision'];
}

async function answersOf(kit: CliHarness): Promise<unknown[]> {
  const text = (await kit.files.read(ANSWERS_LOG)) ?? '';
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line));
}

describe('hook route-allow: service roles', () => {
  it("allows the holder's call with asks on, logging the role, command and issue but never the text", async () => {
    const kit = await boundKit();
    const result = await kit.run(HOOK, { stdin: call(CLOSE), env: ALPHA });
    assert.equal(decisionOf(result), 'allow');
    assert.deepEqual(result.stderr, []);
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: call('teamrig issue comment acme/web#9 --body "On it" --session alpha'), env: {} })), 'allow');
    assert.deepEqual(await answersOf(kit), [
      { v: 1, at: '2030-01-08T10:00:00.000Z', session: 'alpha', claudeSession: CLAUDE_SESSION, tool: 'Bash', event: 'PreToolUse', answer: 'role', role: 'github', command: 'issue close', target: 'acme/web#7' },
      { v: 1, at: '2030-01-08T10:00:00.000Z', session: 'alpha', claudeSession: CLAUDE_SESSION, tool: 'Bash', event: 'PreToolUse', answer: 'role', role: 'github', command: 'issue comment', target: 'acme/web#9' },
    ]);
    assert.ok(!(await kit.files.read(ANSWERS_LOG))?.includes('thanks'));
  });

  it("gives a tab bound to alpha no role of bravo's, whether it read bravo's inbox or names bravo (C1)", async () => {
    const bravoHolds = { serviceRoles: { github: { holders: ['bravo'], commands: ['issue close'] } } };
    const read = await boundKit(bravoHolds);
    await mark(read, 'bravo');
    assert.deepEqual(await read.run(HOOK, { stdin: call(`${UNNAMED} --session bravo`), env: { TEAMRIG_SESSION: 'bravo' } }), NOTHING);
    const named = await boundKit(bravoHolds);
    assert.deepEqual(await named.run(HOOK, { stdin: call(`${UNNAMED} --session bravo`), env: ALPHA }), NOTHING);
    assert.deepEqual(await (await boundKit()).run(HOOK, { stdin: call(UNNAMED), env: ALPHA }), NOTHING, "the holder's call naming no session, though the environment names alpha (N1)");
    const holder = await boundKit();
    assert.deepEqual(await holder.run(HOOK, { stdin: call(`${UNNAMED} --session bravo`), env: ALPHA }), NOTHING, "alpha's tab running as bravo");
    assert.deepEqual(await answersOf(read), []);
  });

  it('gives no role to a tab with no mark, another tab, no Claude Code session, or no session to run as', async () => {
    const unmarked = new CliHarness(roleTeam());
    await mark(unmarked, 'alpha', 'ffffffff-0000-4000-8000-000000000001');
    assert.deepEqual(await unmarked.run(HOOK, { stdin: call(CLOSE), env: ALPHA }), NOTHING);
    const kit = await boundKit();
    assert.deepEqual(await kit.run(HOOK, { stdin: call(CLOSE, { session_id: 'not-an-id' }), env: ALPHA }), NOTHING);
    assert.deepEqual(await kit.run(HOOK, { stdin: call(UNNAMED), env: {} }), NOTHING);
  });

  it('gives no role for a call off its shape, a repository off the list, or a command the role does not hold', async () => {
    const kit = await boundKit({ serviceRoles: { github: { holders: ['alpha'], commands: ['issue comment'] } } });
    for (const line of [CLOSE, 'teamrig issue comment other/web#7 --body "x" --session alpha', 'teamrig issue comment acme/web#7 --body "x" --session alpha; rm -rf y', 'teamrig issue sync']) {
      assert.deepEqual(await kit.run(HOOK, { stdin: call(line), env: ALPHA }), NOTHING, line);
    }
    assert.deepEqual(await kit.run(HOOK, { stdin: call('teamrig issue comment acme/web#7 --body "x" --session alpha', { tool_name: 'PowerShell' }), env: ALPHA }), NOTHING);
  });

  it('stays out when a guard refuses the call, so that guard answers it', async () => {
    const kit = await boundKit();
    assert.deepEqual(await kit.run(HOOK, { stdin: call(`teamrig issue comment acme/web#7 --body "${TOKEN}" --session alpha`), env: ALPHA }), NOTHING);
    assert.deepEqual(await answersOf(kit), []);
  });

  it('asks the owner once the role ran its daily cap, refusing when asks are off, and counts a rolling day (C6)', async () => {
    const kit = await boundKit({ prompts: { serviceRoleDailyCap: 2 } });
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: call(CLOSE), env: ALPHA })), 'allow');
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: call(CLOSE), env: ALPHA })), 'allow');
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: call(CLOSE), env: ALPHA })), 'ask');
    assert.equal((await answersOf(kit)).length, 2);
    kit.clock.advance(24 * 60 * 60 * 1000 + 1);
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: call(CLOSE), env: ALPHA })), 'allow');
    const refusing = await boundKit({ prompts: { hookAsks: 'refuse', serviceRoleDailyCap: 0 } });
    assert.equal(decisionOf(await refusing.run(HOOK, { stdin: call(CLOSE), env: ALPHA })), 'deny');
  });

  it('gives no role with the switch off, with any config issue, or when the log cannot be written', async () => {
    const off = await boundKit({ prompts: { routeAllow: 'off' } });
    assert.deepEqual(await off.run(HOOK, { stdin: call(CLOSE), env: ALPHA }), NOTHING);
    const broken = await boundKit({ prompts: { serviceRoleDailyCap: 500 } });
    assert.deepEqual(await broken.run(HOOK, { stdin: call(CLOSE), env: ALPHA }), NOTHING);
    const full = await boundKit();
    const files = new FaultyFiles(full.files).fail('append', ANSWERS_LOG, systemError('ENOSPC'));
    assert.deepEqual(await full.run(HOOK, { stdin: call(CLOSE), env: ALPHA, files }), NOTHING);
  });
});
