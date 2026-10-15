import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isRecord } from '../core/guards.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { APP, CLAUDE_SESSION, CliHarness, contextOf, TEAM, TEAM_HOME, USER_HOME, type CliResult } from '../testing/cli-harness.ts';

const OPUS = 'claude-opus-5-5';
const FABLE = 'claude-fable-5';
const LEAD_ON_SONNET = 'MODEL app-lead runs model claude-sonnet-5; the team config asks for model opus at xhigh effort: type /model opus';

function start(model?: string): string {
  return JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, source: 'startup', ...(model === undefined ? {} : { model }) });
}

/** The line the hook shows the user, if any. */
function noticeOf(result: CliResult): string | undefined {
  const parsed: unknown = JSON.parse(result.stdout[0] ?? '');
  assert.ok(isRecord(parsed));
  const notice = parsed['systemMessage'];
  return typeof notice === 'string' ? notice : undefined;
}

async function sessionStart(session: string, stdin: string, env: Readonly<Record<string, string>> = {}, kit = new CliHarness(TEAM)): Promise<CliResult> {
  return kit.run(['hook', 'session-start'], { stdin, env: { TEAMRIG_SESSION: session, ...env } });
}

describe('the SessionStart hook checks the model and effort', () => {
  it('tells the lead, and the user, when it runs on another model than opus', async () => {
    const result = await sessionStart('lead', start('claude-sonnet-5'));
    assert.equal(noticeOf(result), LEAD_ON_SONNET);
    assert.ok(contextOf(result).includes(`\n${LEAD_ON_SONNET}`));
  });

  it('leaves the effort to the Stop hook: $CLAUDE_EFFORT at a start can be the value of the session whose shell started it', async () => {
    const result = await sessionStart('lead', start(OPUS), { CLAUDE_EFFORT: 'high' });
    assert.equal(noticeOf(result), undefined);
  });

  it('checks another session against its own launch entry, and by name', async () => {
    const kit = new CliHarness({ ...TEAM, launch: { alpha: { model: 'sonnet' } } });
    const result = await sessionStart('app-alpha', start('claude-haiku-5-5'), {}, kit);
    assert.equal(noticeOf(result), 'MODEL app-alpha runs model claude-haiku-5-5; the team config asks for model sonnet at the default effort: type /model sonnet');
  });

  it('stays silent when it matches, nothing is configured, the model is not given or the session is unknown', async () => {
    for (const [session, stdin] of [
      ['lead', start(OPUS)],
      ['alpha', start(FABLE)],
      ['lead', start()],
      ['zulu', start(OPUS)],
    ] as const) {
      const result = await sessionStart(session, stdin);
      assert.equal(result.stdout.length, 1);
      assert.equal(noticeOf(result), undefined, `${session} ${stdin}`);
    }
  });
});

const TRANSCRIPT = join(USER_HOME, '.claude', 'projects', 'app', `${CLAUDE_SESSION}.jsonl`);
const NOTICES = (id: string): string => join(TEAM_HOME, 'state', 'model-notices', `${id}.json`);
const LEAD_AT_HIGH = 'MODEL app-lead runs at high effort; the team config asks for model opus at xhigh effort: type /effort xhigh';
const ALPHA_SWITCHED =
  'MODEL app-alpha now runs model claude-opus-4-8, not claude-fable-5-1: Claude Code switched after its safeguards stopped a reply (cyber) and keeps it for this session; type /model claude-fable-5-1 to switch back';

/** A Stop payload; `effort` is the level Claude Code reports, if any. */
function stopPayload(effort?: string, claudeSession: string = CLAUDE_SESSION): string {
  return JSON.stringify({ session_id: claudeSession, cwd: APP, transcript_path: TRANSCRIPT, stop_hook_active: false, ...(effort === undefined ? {} : { effort: { level: effort } }) });
}

/** A transcript in which Claude Code switched the session from Fable to Opus 4.8 after a safeguard stop. */
function switchedTranscript(): string {
  const reply = (model: string): string => JSON.stringify({ type: 'assistant', isSidechain: false, requestedModel: model, message: { model, content: [] } });
  const entry = { type: 'system', subtype: 'model_refusal_fallback', isSidechain: false, originalModel: 'claude-fable-5-1', fallbackModel: 'claude-opus-4-8', apiRefusalCategory: 'cyber', uuid: 'switch-1' };
  return [reply('claude-fable-5-1'), JSON.stringify(entry), reply('claude-opus-4-8')].join('\n') + '\n';
}

async function stopAs(kit: CliHarness, session: string, stdin: string, files?: FaultyFiles): Promise<CliResult> {
  return kit.run(['hook', 'stop'], { stdin, env: { TEAMRIG_SESSION: session }, ...(files === undefined ? {} : { files }) });
}

describe('the Stop hook checks the effort and the model that answers', () => {
  it('tells the user once per Claude Code session when the lead runs at another effort, refresh on or off', async () => {
    for (const kit of [new CliHarness(), new CliHarness({ ...TEAM, refresh: { enabled: false } })]) {
      assert.equal(noticeOf(await stopAs(kit, 'lead', stopPayload('high'))), LEAD_AT_HIGH);
      assert.deepEqual((await stopAs(kit, 'lead', stopPayload('high'))).stdout, [], 'once');
      assert.equal(noticeOf(await stopAs(kit, 'lead', stopPayload('high', '0123abcd-0000-4000-8000-00000000000b'))), LEAD_AT_HIGH, 'again after a /clear');
      assert.deepEqual((await stopAs(kit, 'lead', stopPayload('xhigh'))).stdout, []);
      assert.deepEqual((await stopAs(kit, 'alpha', stopPayload('low'))).stdout, [], 'alpha has no launch entry');
    }
  });

  it('tells the user once when Claude Code switched any session to another model', async () => {
    const kit = new CliHarness();
    await kit.files.write(TRANSCRIPT, switchedTranscript());
    assert.equal(noticeOf(await stopAs(kit, 'alpha', stopPayload())), ALPHA_SWITCHED);
    assert.deepEqual((await stopAs(kit, 'alpha', stopPayload())).stdout, [], 'once');
    assert.equal(noticeOf(await stopAs(kit, 'lead', stopPayload('high'))), `${LEAD_AT_HIGH}
${ALPHA_SWITCHED.replace('app-alpha', 'app-lead').replace('claude-fable-5-1 to', 'opus to')}`);
  });

  it('shows nothing it cannot record, and nothing for an unknown session', async () => {
    const kit = new CliHarness();
    const files = new FaultyFiles(kit.files).fail('write', NOTICES('lead'), systemError('EACCES'));
    assert.deepEqual(await stopAs(kit, 'lead', stopPayload('high'), files), { code: 0, stdout: [], stderr: [] });
    assert.deepEqual((await stopAs(kit, 'zulu', stopPayload('high'))).stdout, []);
    assert.deepEqual((await kit.run(['hook', 'stop'], { stdin: JSON.stringify({ cwd: APP, effort: { level: 'high' } }), env: { TEAMRIG_SESSION: 'lead' } })).stdout, [], 'no Claude Code session id');
    assert.equal(noticeOf(await stopAs(kit, 'lead', stopPayload('high'))), LEAD_AT_HIGH);
  });
});
