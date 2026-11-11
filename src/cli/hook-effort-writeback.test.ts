import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import { isRecord, stringField, type JsonRecord } from '../core/guards.ts';
import { APP, CLAUDE_SESSION, CliHarness, CONFIG_PATH, TEAM, TEAM_HOME, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { teamConfigOf, teamInboxOf } from '../testing/team-tree.ts';
import { effortLines, transcript } from '../testing/transcript-lines.ts';

const MINUTE = 60_000;
const TRANSCRIPT = join(USER_HOME, '.claude', 'projects', 'app', `${CLAUDE_SESSION}.jsonl`);
const CHANGES = join(TEAM_HOME, 'state', 'effort-changes.jsonl');
const LEAD_INBOX = teamInboxOf('app', 'lead');
const ALPHA_HIGH: JsonRecord = { ...TEAM, launch: { alpha: { model: 'sonnet', effort: 'high' } } };
const ALPHA_MEDIUM: JsonRecord = { ...TEAM, launch: { alpha: { model: 'sonnet', effort: 'medium' } } };
const ALPHA_TO_MEDIUM = 'EFFORT app-alpha: the typed /effort medium is now its launch effort in the app config (was high); a restore or restart opens it at medium';
const LEAD_XHIGH: JsonRecord = { launch: { lead: { model: 'opus', effort: 'xhigh' } } };
const ROOT_TEAM: JsonRecord = { configVersion: 1, team: { id: 'root' }, sessions: ['lead', 'po'], roles: { lead: 'lead' } };

/** A hook payload: Stop with the level Claude Code reports, if any, or SessionEnd, which reports none. */
function payloadOf(event: 'Stop' | 'SessionEnd', effort?: string): string {
  const common = { session_id: CLAUDE_SESSION, cwd: APP, transcript_path: TRANSCRIPT, hook_event_name: event };
  const own = event === 'Stop' ? { stop_hook_active: false } : { reason: 'prompt_input_exit' };
  return JSON.stringify({ ...common, ...own, ...(effort === undefined ? {} : { effort: { level: effort } }) });
}

async function stopAs(kit: CliHarness, session: string, effort: string): Promise<CliResult> {
  return kit.run(['hook', 'stop'], { stdin: payloadOf('Stop', effort), env: { TEAMRIG_SESSION: session } });
}

async function endAs(kit: CliHarness, session: string, stdin: string = payloadOf('SessionEnd')): Promise<CliResult> {
  return kit.run(['hook', 'effort-writeback'], { stdin, env: { TEAMRIG_SESSION: session } });
}

/** The user types `/effort <level>` a minute on, which Claude Code sets; the next turn ends a minute after. */
async function typeEffort(kit: CliHarness, level: string): Promise<void> {
  kit.clock.advance(MINUTE);
  const at = new Date(kit.clock.now()).toISOString();
  await kit.files.write(TRANSCRIPT, transcript(effortLines({ uuid: `typed-${level}`, at, sessionId: CLAUDE_SESSION, args: level, set: level })));
  kit.clock.advance(MINUTE);
}

/** The line the Stop hook shows the user, if any. */
function noticeOf(result: CliResult): string | undefined {
  const parsed: unknown = JSON.parse(result.stdout[0] ?? '');
  assert.ok(isRecord(parsed));
  const notice = parsed['systemMessage'];
  return typeof notice === 'string' ? notice : undefined;
}

function changesOf(kit: CliHarness): readonly JsonRecord[] {
  const text = kit.files.get(CHANGES) ?? '';
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line): JsonRecord => {
      const parsed: unknown = JSON.parse(line);
      assert.ok(isRecord(parsed));
      return parsed;
    });
}

const QUIET: CliResult = { code: 0, stdout: [], stderr: [] };

describe('the Stop hook writes a typed /effort back to the launch entry (T2441)', () => {
  it('writes the level, keeps the old config, logs the change, tells the lead and the user, and does it once', async () => {
    const kit = new CliHarness(ALPHA_HIGH);
    const before = kit.files.get(CONFIG_PATH);
    assert.deepEqual((await stopAs(kit, 'alpha', 'high')).stdout, [], 'the first look only saves the marks');
    await typeEffort(kit, 'medium');

    assert.equal(noticeOf(await stopAs(kit, 'alpha', 'medium')), ALPHA_TO_MEDIUM, 'no MODEL notice for the level just written');
    assert.equal(kit.files.get(CONFIG_PATH), formatConfig(ALPHA_MEDIUM));
    assert.match(kit.files.get(LEAD_INBOX) ?? '', / teamrig: alpha effort high -> medium \(a typed \/effort at 10:01 UTC\), written to its launch entry in the app config/);
    const [change, ...more] = changesOf(kit);
    assert.deepEqual(more, []);
    assert.ok(change !== undefined);
    assert.deepEqual({ ...change, backup: undefined }, {
      v: 1,
      at: '2030-01-08T10:02:00.000Z',
      session: 'alpha',
      from: 'high',
      to: 'medium',
      claude: CLAUDE_SESSION,
      uuid: 'typed-medium',
      typedAt: '2030-01-08T10:01:00.000Z',
      backup: undefined,
    });
    const backup = stringField(change, 'backup');
    assert.ok(backup !== undefined);
    assert.equal(kit.files.get(backup), before, 'the backup holds the config as it was');

    assert.deepEqual((await stopAs(kit, 'alpha', 'medium')).stdout, [], 'a typed entry is taken up once');
    assert.equal(changesOf(kit).length, 1);
  });

  it('tells a root lead itself, and the lead of a child team the lead above it', async () => {
    const root = new CliHarness({ ...TEAM, ...LEAD_XHIGH });
    await stopAs(root, 'lead', 'xhigh');
    await typeEffort(root, 'high');
    assert.match(noticeOf(await stopAs(root, 'lead', 'high')) ?? '', /^EFFORT app-lead: the typed \/effort high is now its launch effort in the app config \(was xhigh\)/);
    assert.match(root.files.get(LEAD_INBOX) ?? '', / teamrig: lead effort xhigh -> high \(a typed \/effort at 10:01 UTC\)/);

    const child = new CliHarness({ ...TEAM, team: { id: 'app', parent: 'root' }, ...LEAD_XHIGH });
    await child.files.write(teamConfigOf('root'), formatConfig(ROOT_TEAM));
    await stopAs(child, 'lead', 'xhigh');
    await typeEffort(child, 'high');
    await stopAs(child, 'lead', 'high');
    assert.match(child.files.get(teamInboxOf('root', 'lead')) ?? '', / app\/teamrig: app\/lead effort xhigh -> high \(a typed \/effort at 10:01 UTC\)/);
    assert.equal(child.files.get(LEAD_INBOX), undefined);
  });

  it('tells the lead of a child team itself when the team above has no config, which doctor names', async () => {
    const kit = new CliHarness({ ...TEAM, team: { id: 'app', parent: 'root' }, ...LEAD_XHIGH });
    await stopAs(kit, 'lead', 'xhigh');
    await typeEffort(kit, 'high');
    await stopAs(kit, 'lead', 'high');
    assert.match(kit.files.get(LEAD_INBOX) ?? '', / teamrig: lead effort xhigh -> high /);
  });

  it('keeps the written level and shows the user each of the log line and the leader that failed', async () => {
    for (const failed of [[LEAD_INBOX], [CHANGES], [CHANGES, LEAD_INBOX]]) {
      const kit = new CliHarness(ALPHA_HIGH);
      await stopAs(kit, 'alpha', 'high');
      await typeEffort(kit, 'medium');
      const files = new FaultyFiles(kit.files);
      for (const path of failed) {
        files.fail('append', path, systemError('EACCES', 'EACCES: permission denied'));
      }
      const result = await kit.run(['hook', 'stop'], { stdin: payloadOf('Stop', 'medium'), env: { TEAMRIG_SESSION: 'alpha' }, files });
      const expected = [
        ALPHA_TO_MEDIUM,
        ...(failed.includes(CHANGES) ? ['EFFORT app-alpha: the change is not in the effort change log: EACCES: permission denied'] : []),
        ...(failed.includes(LEAD_INBOX) ? ['INBOX lead: not told of the effort change: EACCES: permission denied'] : []),
      ];
      assert.deepEqual((noticeOf(result) ?? '').split('\n'), expected, failed.join(', '));
      assert.equal(kit.files.get(CONFIG_PATH), formatConfig(ALPHA_MEDIUM));
      assert.equal(changesOf(kit).length, failed.includes(CHANGES) ? 0 : 1);
    }
  });

  it('writes nothing to a config with a problem, and takes the typing up at the first turn after its fix', async () => {
    const kit = new CliHarness({ ...ALPHA_HIGH, refresh: { enabled: 'yes' } });
    const broken = kit.files.get(CONFIG_PATH);
    await stopAs(kit, 'alpha', 'high');
    await typeEffort(kit, 'medium');
    const refused = await stopAs(kit, 'alpha', 'medium');
    assert.doesNotMatch(refused.stdout.join('\n'), /EFFORT/);
    assert.equal(kit.files.get(CONFIG_PATH), broken);
    assert.deepEqual(changesOf(kit), []);

    await kit.files.write(CONFIG_PATH, formatConfig(ALPHA_HIGH));
    kit.clock.advance(MINUTE);
    assert.equal(noticeOf(await stopAs(kit, 'alpha', 'medium')), ALPHA_TO_MEDIUM);
    assert.equal(kit.files.get(CONFIG_PATH), formatConfig(ALPHA_MEDIUM));
  });
});

describe('hook effort-writeback, at SessionEnd (T2441)', () => {
  it('writes a level typed with no turn after it, silently, and the next turn writes nothing more', async () => {
    const kit = new CliHarness(ALPHA_HIGH);
    await stopAs(kit, 'alpha', 'high');
    await typeEffort(kit, 'medium');
    assert.deepEqual(await endAs(kit, 'alpha'), QUIET);
    assert.equal(kit.files.get(CONFIG_PATH), formatConfig(ALPHA_MEDIUM));
    assert.match(kit.files.get(LEAD_INBOX) ?? '', / teamrig: alpha effort high -> medium /);
    assert.deepEqual((await stopAs(kit, 'alpha', 'medium')).stdout, []);
    assert.equal(changesOf(kit).length, 1);
  });

  it('writes nothing again after a Stop wrote the level', async () => {
    const kit = new CliHarness(ALPHA_HIGH);
    await stopAs(kit, 'alpha', 'high');
    await typeEffort(kit, 'medium');
    assert.equal(noticeOf(await stopAs(kit, 'alpha', 'medium')), ALPHA_TO_MEDIUM);
    assert.deepEqual(await endAs(kit, 'alpha'), QUIET);
    assert.equal(changesOf(kit).length, 1);
  });

  it('never fails: an unknown session, a payload that is not JSON or has no Claude Code session id', async () => {
    const kit = new CliHarness(ALPHA_HIGH);
    for (const [session, stdin] of [
      ['zulu', payloadOf('SessionEnd')],
      ['alpha', '{ not json'],
      ['alpha', JSON.stringify({ cwd: APP, transcript_path: TRANSCRIPT, hook_event_name: 'SessionEnd' })],
    ] as const) {
      assert.deepEqual(await endAs(kit, session, stdin), QUIET, `${session} ${stdin}`);
    }
    assert.equal(kit.files.get(CONFIG_PATH), formatConfig(ALPHA_HIGH));
  });
});
