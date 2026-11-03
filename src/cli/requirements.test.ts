import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { isRecord } from '../core/guards.ts';
import type { RequirementProblem, RequirementsCheck } from '../requirements/requirements.ts';
import { FakePathProbe } from '../testing/fake-processes.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const GIT_MISSING = 'git is not installed or not on PATH, and teamrig needs it: install it from git-scm.com, then restart Claude Code.';
const OLD_CLAUDE = 'Claude Code 2.1.130 is older than teamrig needs (2.1.139 or later): run claude update, then restart Claude Code.';
const OTHER_SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';

function lacking(...problems: RequirementProblem[]): RequirementsCheck {
  return { problems: async () => problems };
}

function start(session: string = CLAUDE_SESSION, model?: string): string {
  return JSON.stringify({ session_id: session, cwd: APP, source: 'startup', ...(model === undefined ? {} : { model }) });
}

/** The line the SessionStart hook shows the user, if any. */
function noticeOf(result: CliResult): string | undefined {
  const parsed: unknown = JSON.parse(result.stdout[0] ?? '');
  assert.ok(isRecord(parsed));
  const notice = parsed['systemMessage'];
  return typeof notice === 'string' ? notice : undefined;
}

describe('the SessionStart hook tells the user what teamrig lacks', () => {
  it('shows each problem once per Claude Code session, and again for a new session', async () => {
    const kit = new CliHarness(TEAM);
    const requirements = lacking({ kind: 'git-missing' }, { kind: 'claude-code-old', running: '2.1.130' });
    const run = (stdin: string): Promise<CliResult> => kit.run(['hook', 'session-start'], { stdin, env: { TEAMRIG_SESSION: 'lead' }, requirements });
    assert.equal(noticeOf(await run(start())), `${GIT_MISSING}\n${OLD_CLAUDE}`);
    assert.equal(noticeOf(await run(start())), undefined);
    assert.equal(noticeOf(await run(start(OTHER_SESSION))), `${GIT_MISSING}\n${OLD_CLAUDE}`);
  });

  it("moves an ended session's notice record older than a week to the archive when it records a new one (T336)", async () => {
    const kit = new CliHarness(TEAM);
    const hints = join(TEAM_HOME, 'state', 'bind-hints.jsonl');
    const old = `${JSON.stringify({ v: 1, claudeSession: OTHER_SESSION, reason: 'git-missing', at: '2029-12-20T10:00:00.000Z' })}\n`;
    await kit.files.write(hints, old);
    const result = await kit.run(['hook', 'session-start'], { stdin: start(), env: { TEAMRIG_SESSION: 'lead' }, requirements: lacking({ kind: 'git-missing' }) });
    assert.equal(noticeOf(result), GIT_MISSING);
    assert.equal(await kit.files.read(join(TEAM_HOME, 'state', 'archive', 'bind-hints-20300108.jsonl')), old);
    assert.equal((await kit.files.read(hints))?.includes(OTHER_SESSION), false);
  });

  it('shows it every time when the payload names no session', async () => {
    const kit = new CliHarness(TEAM);
    const run = (): Promise<CliResult> => kit.run(['hook', 'session-start'], { stdin: JSON.stringify({ cwd: APP }), env: { TEAMRIG_SESSION: 'lead' }, requirements: lacking({ kind: 'git-missing' }) });
    assert.equal(noticeOf(await run()), GIT_MISSING);
    assert.equal(noticeOf(await run()), GIT_MISSING);
  });

  it('shows it under the model notice', async () => {
    const result = await new CliHarness(TEAM).run(['hook', 'session-start'], { stdin: start(CLAUDE_SESSION, 'claude-sonnet-5'), env: { TEAMRIG_SESSION: 'lead' }, requirements: lacking({ kind: 'git-missing' }) });
    const notice = noticeOf(result) ?? '';
    assert.ok(notice.startsWith('MODEL app-lead runs model claude-sonnet-5'), notice);
    assert.ok(notice.endsWith(`\n${GIT_MISSING}`), notice);
  });

  it('says nothing when nothing is missing', async () => {
    const result = await new CliHarness(TEAM).run(['hook', 'session-start'], { stdin: start(), env: { TEAMRIG_SESSION: 'lead' } });
    assert.equal(noticeOf(result), undefined);
  });

  it('stays silent outside a team, as every hook does', async () => {
    const result = await new CliHarness(TEAM, null).run(['hook', 'session-start'], { stdin: start(), requirements: lacking({ kind: 'git-missing' }) });
    assert.deepEqual(result, { code: EXIT.ok, stdout: [], stderr: [] });
  });
});

describe('team create and doctor tell the user what teamrig lacks', () => {
  const shop = resolve('/', 'w', 'shop');
  const create = ['team', 'create', 'shop', '--sessions', 'api,web', '--project', shop];

  it('team create warns first, then sets the team up', async () => {
    const result = await new CliHarness(null, null).run(create, { probe: new FakePathProbe({ folders: [shop] }), requirements: lacking({ kind: 'claude-code-old', running: '2.1.130' }) });
    assert.equal(result.code, EXIT.ok);
    assert.equal(result.stdout[0], `WARN ${OLD_CLAUDE}`);
    assert.ok(result.stdout.some((line) => line.startsWith('CREATED ')));
  });

  it('team create warns even when it then refuses', async () => {
    const result = await new CliHarness(null, null).run(create, { requirements: lacking({ kind: 'git-missing' }) });
    assert.equal(result.code, EXIT.refused);
    assert.deepEqual(result.stdout, [`WARN ${GIT_MISSING}`, `REFUSED the project folder ${shop} does not exist`]);
  });

  it('doctor counts each as a finding', async () => {
    const kit = new CliHarness(TEAM);
    await kit.holdSecretDeny();
    const result = await kit.run(['doctor'], { requirements: lacking({ kind: 'git-missing' }) });
    assert.deepEqual(result.stdout, ['DOCTOR 1 finding(s), team app', `WARN requirement ${GIT_MISSING}`]);
  });
});
