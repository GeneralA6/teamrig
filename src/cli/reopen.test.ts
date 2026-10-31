import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { projectTranscriptPath } from '../budget/discover.ts';
import type { CommitCharge } from '../delivery/memory.ts';
import type { Files } from '../core/files.ts';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { MS_PER_MINUTE } from '../core/time.ts';
import { inboxLineOf } from '../inbox/inbox.ts';
import { lineHash } from '../inbox/line-hash.ts';
import { decodePrompt, defaultPrompt, reopenPrompt } from '../open/prompt.ts';
import { homeCloseOf, SessionLog, type CloseRecord } from '../sessions/log.ts';
import { APP, CLAUDE_SESSION, CliHarness, EVENTS_PATH, TEAM, TEAM_HOME, USER_HOME, type CliResult, type RunOptions } from '../testing/cli-harness.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { FakePathProbe, FakeProcesses } from '../testing/fake-processes.ts';
import { ok } from '../testing/hired-team.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { WakeAsks } from '../wake/asks.ts';
import { WakeStore } from '../wake/store.ts';
import { EXIT } from './runtime.ts';

const HOUR_MS = 3_600_000;
const LOG = join(TEAM_HOME, 'state', 'session-log.jsonl');
const TRANSCRIPT = projectTranscriptPath(join(USER_HOME, '.claude', 'projects'), APP, CLAUDE_SESSION);
/** Alpha, closed by the lead after 75 quiet minutes in Claude Code session CLAUDE_SESSION. */
const CLOSED: CloseRecord = { kind: 'close', session: 'alpha', by: 'lead', at: '2030-01-08T08:00:00.000Z', claudeSession: CLAUDE_SESSION, idleMinutes: 75, freedMb: 1300 };

/** A transcript line the way Claude Code writes an assistant reply, with `tokens` of context. */
function reply(tokens: number): string {
  return `${JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', usage: { input_tokens: 2, cache_read_input_tokens: tokens - 2, output_tokens: 50 } } })}\n`;
}

interface ClosedAlpha {
  readonly kit: CliHarness;
  readonly options: RunOptions;
}

/** A team (`config`) whose alpha the lead closed, its last transcript holding `tokens` of context, last written 2 h ago. */
async function closedAlpha(tokens: number, config: JsonRecord = TEAM): Promise<ClosedAlpha> {
  const kit = new CliHarness(config);
  await new SessionLog(kit.files, LOG).append(CLOSED);
  await kit.files.write(TRANSCRIPT, reply(tokens));
  const transcripts = new MemoryTranscripts({ [TRANSCRIPT]: reply(tokens) }, kit.clock.now() - 2 * HOUR_MS);
  return { kit, options: { platform: 'win32', probe: new FakePathProbe({ folders: [APP] }), transcripts } };
}

/** Alpha, hired by the lead with no room on the host, so it started home (T1364). */
const HOME: CloseRecord = homeCloseOf('alpha', 'lead', '2030-01-08T08:00:00.000Z');

/** A team whose alpha was hired home: it never ran, so no transcript of it is anywhere. */
async function homeAlpha(): Promise<ClosedAlpha> {
  const kit = new CliHarness(TEAM);
  await new SessionLog(kit.files, LOG).append(HOME);
  return { kit, options: { platform: 'win32', probe: new FakePathProbe({ folders: [APP] }) } };
}

/** Opens alpha in a Windows Terminal tab; returns the run and what the tab runs. */
async function open(alpha: ClosedAlpha, extra: readonly string[] = []): Promise<{ result: CliResult; argv: readonly string[] }> {
  const processes = new FakeProcesses().onStart('wt.exe', { kind: 'started', end: 'exited' });
  const result = await alpha.kit.run(['open', 'alpha', ...extra], { ...alpha.options, processes });
  return { result, argv: processes.started[0]?.args ?? [] };
}

/** The first prompt a tab's launch line carries. */
function promptOf(argv: readonly string[]): string | undefined {
  const encoded = argv[argv.indexOf('--encoded-prompt') + 1];
  return encoded === undefined ? undefined : decodePrompt(encoded);
}

/** The Claude Code session a tab's launch line resumes, if any. */
function resumedOf(argv: readonly string[]): string | undefined {
  const at = argv.indexOf('--resume');
  return at < 0 ? undefined : argv[at + 1];
}

async function logOf(alpha: ClosedAlpha): Promise<unknown> {
  return (await new SessionLog(alpha.kit.files, LOG).read()).records;
}

describe('opening a session teamrig closed', () => {
  it('resumes its last Claude Code session, logs the reopen, and then opens it as any session', async () => {
    const alpha = await closedAlpha(40_000);
    const { result, argv } = await open(alpha);
    assert.ok(ok(result).stdout[0]?.endsWith(`, resuming Claude Code session ${CLAUDE_SESSION}`), result.stdout[0]);
    assert.equal(resumedOf(argv), CLAUDE_SESSION);
    assert.equal(promptOf(argv), reopenPrompt('app', 'alpha'));
    const at = new Date(alpha.kit.clock.now()).toISOString();
    assert.deepEqual(await logOf(alpha), [CLOSED, { kind: 'reopen', session: 'alpha', at, resumed: CLAUDE_SESSION }]);

    const again = await open(alpha);
    assert.equal(resumedOf(again.argv), undefined, 'once reopened, it opens as any session');
    assert.equal(promptOf(again.argv), defaultPrompt('app', 'alpha'));
    assert.equal((await new SessionLog(alpha.kit.files, LOG).read()).records.length, 2);
  });

  it('opens fresh, with why, when its last session is too big, and --resume then refuses', async () => {
    const alpha = await closedAlpha(400_000);
    const refused = await open(alpha, ['--resume']);
    assert.equal(refused.result.code, EXIT.refused);
    assert.match(refused.result.stdout.join('\n'), /^REFUSED not resumed: its last Claude Code session \S+ holds 400000 tokens of context, idle 0\.1 day\(s\): over hiring\.resumeMaxTokens 250000; teamrig open alpha opens it fresh$/);
    assert.deepEqual(refused.argv, [], 'a refusal opens no tab');
    assert.deepEqual(await logOf(alpha), [CLOSED]);

    const { result, argv } = await open(alpha);
    assert.ok(ok(result).stdout[0]?.endsWith(', fresh (its last Claude Code session ' + CLAUDE_SESSION + ' holds 400000 tokens of context, idle 0.1 day(s): over hiring.resumeMaxTokens 250000)'), result.stdout[0]);
    assert.equal(resumedOf(argv), undefined);
    assert.equal(promptOf(argv), defaultPrompt('app', 'alpha'));
    assert.deepEqual(await logOf(alpha), [CLOSED, { kind: 'reopen', session: 'alpha', at: new Date(alpha.kit.clock.now()).toISOString() }]);
  });

  it('resumes it in the folder its close recorded, and opens it fresh in the project once that folder is gone (T1408)', async () => {
    const fix = join(APP, '.claude', 'worktrees', 'fix');
    const filed = projectTranscriptPath(join(USER_HOME, '.claude', 'projects'), fix, CLAUDE_SESSION);
    const inWorktree = async (folders: readonly string[]): Promise<ClosedAlpha> => {
      const kit = new CliHarness(TEAM);
      await new SessionLog(kit.files, LOG).append({ ...CLOSED, folder: fix });
      await kit.files.write(filed, reply(40_000));
      const transcripts = new MemoryTranscripts({ [filed]: reply(40_000) }, kit.clock.now() - 2 * HOUR_MS);
      return { kit, options: { platform: 'win32', probe: new FakePathProbe({ folders }), transcripts } };
    };
    const projectOf = (argv: readonly string[]): string | undefined => argv[argv.indexOf('--project') + 1];

    const alpha = await inWorktree([APP, fix]);
    const { result, argv } = await open(alpha);
    assert.ok(ok(result).stdout[0]?.includes(` in ${fix}, on `), result.stdout[0]);
    assert.equal(resumedOf(argv), CLAUDE_SESSION);
    assert.equal(projectOf(argv), fix, 'Claude Code finds the transcript only from the folder it ran in');
    const printed = await (await inWorktree([APP, fix])).kit.run(['open', 'alpha', '--terminal', 'print'], alpha.options);
    assert.equal(printed.code, EXIT.printed, printed.stdout.join('\n'));
    assert.ok(printed.stdout[1]?.startsWith(`Set-Location -LiteralPath '${fix}'; `), printed.stdout[1]);

    const gone = await open(await inWorktree([APP]));
    assert.ok(ok(gone.result).stdout[0]?.endsWith(`, fresh (${fix}, the folder it ran in, is gone)`), gone.result.stdout[0]);
    assert.equal(resumedOf(gone.argv), undefined);
    assert.equal(projectOf(gone.argv), APP);
  });

  it('opens a hire that started home as a new hire, never resumed, and logs its reopen (T1364)', async () => {
    const alpha = await homeAlpha();
    const refused = await open(alpha, ['--resume']);
    assert.equal(refused.result.code, EXIT.refused, 'a hire that never ran has no Claude Code session to resume');
    assert.deepEqual(await logOf(alpha), [HOME]);

    const { result, argv } = await open(alpha);
    const [line = ''] = ok(result).stdout;
    assert.ok(!line.includes('fresh') && !line.includes('resuming'), line);
    assert.equal(resumedOf(argv), undefined);
    assert.equal(promptOf(argv), defaultPrompt('app', 'alpha'));
    assert.deepEqual(await logOf(alpha), [HOME, { kind: 'reopen', session: 'alpha', at: new Date(alpha.kit.clock.now()).toISOString() }]);
  });

  it('logs no reopen when no terminal opens', async () => {
    const alpha = await closedAlpha(40_000);
    const result = await alpha.kit.run(['open', 'alpha', '--terminal', 'print'], alpha.options);
    assert.equal(result.code, EXIT.printed, result.stdout.join('\n'));
    assert.deepEqual(await logOf(alpha), [CLOSED]);
  });
});

const PASS_LOG = join(TEAM_HOME, 'state', 'idle-pass.jsonl');
const CHARGE: CommitCharge = { usedMb: 40_000, limitMb: 100_700 };

/** Hands alpha a p1 task, which wakes it. */
async function handWork(alpha: ClosedAlpha): Promise<void> {
  const added = await alpha.kit.run(['add', '--title', 'Fix the outage', '--description', 'what and why', '--priority', 'p1', '--owner', 'alpha', '--session', 'lead']);
  assert.equal(added.code, 0, added.stderr.join('\n'));
}

/** Runs the idle pass's reopen of alpha on a host whose memory is `memory`, over `files` when given. */
async function idleOpen(alpha: ClosedAlpha, memory = new FakeHostMemory().lists([], CHARGE), files?: Files): Promise<{ result: CliResult; argv: readonly string[] }> {
  const processes = new FakeProcesses().onStart('wt.exe', { kind: 'started', end: 'exited' });
  const result = await alpha.kit.run(['idle-open', 'alpha', '--team', 'app', '--project', APP], { ...alpha.options, processes, memory, ...(files === undefined ? {} : { files }) });
  return { result, argv: processes.started[0]?.args ?? [] };
}

const ASKS = join(TEAM_HOME, 'state', 'wake-asks');

/** Posts alpha the lead's urgent line, as a send to it while closed does; returns the store. */
async function urgentLine(alpha: ClosedAlpha): Promise<WakeAsks> {
  const asks = new WakeAsks(alpha.kit.files, ASKS);
  await asks.post('alpha', { from: 'lead', text: 'Answer the review on T1.', at: alpha.kit.clock.now() });
  return asks;
}

const WAKES = join(TEAM_HOME, 'state', 'wake');
const WAKE_STATE = join(WAKES, 'alpha.json');
const WAKE_LOG = join(TEAM_HOME, 'state', 'wakes.jsonl');
/** A wake check's answer while it waits for news: nothing to wake for, so no recheck. */
const WAITING = { kind: 'wait', watch: [EVENTS_PATH, join(ASKS, 'alpha')], recheckAt: null };

/** Alpha's wake check in its tab, the Claude Code session a reopen resumes; returns its answer. */
async function wakeCheck(alpha: ClosedAlpha): Promise<unknown> {
  const result = await alpha.kit.run(['hook', 'wake-check'], { stdin: JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP }), transcripts: new MemoryTranscripts() });
  assert.equal(result.code, 0, result.stderr.join('\n'));
  return JSON.parse(result.stdout[0] ?? '');
}

/** A closed alpha whose tab, CLAUDE_SESSION, last checked for wakes before work was handed to it. */
async function checkedBeforeWork(): Promise<ClosedAlpha> {
  const alpha = await closedAlpha(40_000);
  await alpha.kit.run(['inbox', 'read', '--session', 'alpha'], { env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
  assert.deepEqual(await wakeCheck(alpha), WAITING);
  return alpha;
}

/** The pass log's act lines, without their time. */
function actsOf(alpha: ClosedAlpha): JsonRecord[] {
  return (alpha.kit.files.get(PASS_LOG) ?? '')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      assert.ok(isRecord(parsed), line);
      return Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'at'));
    });
}

describe('teamrig idle-open', () => {
  it('reopens a closed session work would wake as teamrig open does, and logs the act with the commit charge before', async () => {
    const alpha = await closedAlpha(40_000);
    await handWork(alpha);
    const { result, argv } = await idleOpen(alpha);
    assert.equal(result.code, 0, [...result.stdout, ...result.stderr].join('\n'));
    const [line = ''] = result.stdout;
    assert.match(line, /^REOPENED app-alpha \(session alpha\) for work handed to it since its close: T1: OPENED app-alpha \(session alpha\) in a new Windows Terminal tab in /);
    assert.ok(line.endsWith(`, resuming Claude Code session ${CLAUDE_SESSION}`), line);
    assert.equal(resumedOf(argv), CLAUDE_SESSION);
    assert.equal(promptOf(argv), reopenPrompt('app', 'alpha'));
    assert.deepEqual(await logOf(alpha), [CLOSED, { kind: 'reopen', session: 'alpha', at: new Date(alpha.kit.clock.now()).toISOString(), resumed: CLAUDE_SESSION }]);
    assert.deepEqual(actsOf(alpha), [{ v: 1, kind: 'act', mode: 'on', act: 'reopen', id: 'alpha', outcome: 'done', line, before: CHARGE }]);
  });

  it('opens a hire that started home once work is handed to it, as a new hire (T1364)', async () => {
    const alpha = await homeAlpha();
    const idle = await idleOpen(alpha);
    assert.deepEqual(idle.result.stdout, ['KEPT app-alpha (session alpha): still closed, nothing it can start']);
    await handWork(alpha);
    const { result, argv } = await idleOpen(alpha);
    assert.equal(result.code, 0, [...result.stdout, ...result.stderr].join('\n'));
    assert.match(result.stdout[0] ?? '', /^REOPENED app-alpha \(session alpha\) for work handed to it since its close: T1: OPENED app-alpha \(session alpha\) in a new Windows Terminal tab in /);
    assert.equal(resumedOf(argv), undefined);
    assert.equal(promptOf(argv), defaultPrompt('app', 'alpha'));
    assert.deepEqual(await logOf(alpha), [HOME, { kind: 'reopen', session: 'alpha', at: new Date(alpha.kit.clock.now()).toISOString() }]);
  });

  it('keeps closed a session with nothing it can start, and opens nothing for one teamrig no longer holds closed', async () => {
    const idle = await closedAlpha(40_000);
    const kept = await idleOpen(idle);
    assert.equal(kept.result.code, 0, kept.result.stderr.join('\n'));
    assert.deepEqual(kept.result.stdout, ['KEPT app-alpha (session alpha): still closed, nothing it can start']);
    assert.deepEqual(kept.argv, []);
    assert.deepEqual(await logOf(idle), [CLOSED]);
    assert.deepEqual(actsOf(idle), [{ v: 1, kind: 'act', mode: 'on', act: 'reopen', id: 'alpha', outcome: 'kept', line: kept.result.stdout[0] }]);

    const reopened = await closedAlpha(40_000);
    await handWork(reopened);
    await new SessionLog(reopened.kit.files, LOG).append({ kind: 'reopen', session: 'alpha', at: '2030-01-08T09:00:00.000Z' });
    const away = await idleOpen(reopened);
    assert.deepEqual(away.result.stdout, ['KEPT app-alpha (session alpha): not running, and teamrig did not close it']);
    assert.deepEqual(away.argv, []);
  });

  it('keeps it closed when the host has no room, and fails, logged, when it cannot weigh it or no terminal opens', async () => {
    const crowded = await closedAlpha(40_000);
    await handWork(crowded);
    const full = { usedMb: 99_000, limitMb: 100_000 };
    const noRoom = await idleOpen(crowded, new FakeHostMemory().lists([], full));
    assert.equal(noRoom.result.code, 0, noRoom.result.stderr.join('\n'));
    assert.match(noRoom.result.stdout.join('\n'), /^KEPT app-alpha \(session alpha\) closed: no room on the host to open app-alpha \(session alpha\), counted at /);
    assert.deepEqual(noRoom.argv, []);
    assert.deepEqual(await logOf(crowded), [CLOSED]);
    assert.deepEqual(actsOf(crowded), [{ v: 1, kind: 'act', mode: 'on', act: 'reopen', id: 'alpha', outcome: 'kept', line: noRoom.result.stdout[0], before: full }]);

    const blind = await closedAlpha(40_000);
    const unweighed = await idleOpen(blind, new FakeHostMemory().lists(undefined));
    assert.equal(unweighed.result.code, EXIT.failed);
    assert.deepEqual(unweighed.result.stdout, ["FAILED to weigh app-alpha (session alpha): teamrig could not list the host's processes, so it cannot tell which sessions run"]);

    const printing = await closedAlpha(40_000, { ...TEAM, open: { terminal: 'print' } });
    await handWork(printing);
    const manual = await idleOpen(printing);
    assert.equal(manual.result.code, EXIT.failed);
    assert.deepEqual(manual.result.stdout, ['FAILED to reopen app-alpha (session alpha): no terminal opened (the terminal setting is print)']);
    assert.deepEqual(await logOf(printing), [CLOSED]);
    assert.equal(actsOf(printing)[0]?.['outcome'], 'failed');
  });

  it('keeps it closed, unmeasured, while the teamrig install lacks a file its hooks run', async () => {
    const copying = await closedAlpha(40_000);
    await handWork(copying);
    const plugins = join(USER_HOME, '.claude', 'plugins');
    const install = join(plugins, 'cache', 'teamrig', 'teamrig', '0.167.0');
    await copying.kit.files.write(join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'teamrig@teamrig': [{ scope: 'user', installPath: install, version: '0.167.0' }] } }));
    await copying.kit.files.write(join(install, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {} }));
    const kept = await idleOpen(copying);
    assert.equal(kept.result.code, 0, kept.result.stderr.join('\n'));
    assert.deepEqual(kept.result.stdout, ['KEPT app-alpha (session alpha) closed: teamrig 0.167.0 lacks dist/cli/main.js, so the reopen waits for a settled install']);
    assert.deepEqual(kept.argv, []);
    assert.deepEqual(await logOf(copying), [CLOSED]);
    assert.deepEqual(actsOf(copying), [{ v: 1, kind: 'act', mode: 'on', act: 'reopen', id: 'alpha', outcome: 'kept', line: kept.result.stdout[0] }]);
  });

  it('quotes the urgent lines posted while it was closed ahead of its first prompt, and takes them once its tab opened', async () => {
    const alpha = await closedAlpha(40_000);
    const asks = await urgentLine(alpha);
    const { result, argv } = await idleOpen(alpha);
    assert.equal(result.code, 0, [...result.stdout, ...result.stderr].join('\n'));
    assert.match(result.stdout[0] ?? '', /^REOPENED app-alpha \(session alpha\) for an urgent line from lead: OPENED app-alpha \(session alpha\) in a new Windows Terminal tab in .*, resuming Claude Code session \S+$/);
    const [heading, quoted, ...rest] = (promptOf(argv) ?? '').split('\n');
    assert.equal(heading, 'Urgent lines were posted for you while you were closed; act on each first:');
    assert.match(quoted ?? '', /^- \d\d:\d\d \S+ lead: Answer the review on T1\.$/);
    assert.deepEqual(rest, [reopenPrompt('app', 'alpha')]);
    assert.deepEqual(await asks.read('alpha'), [], 'taken, so its wake check does not wake it on them again');
  });

  it('reopens for a --wake-by line only from its time, quoting it', async () => {
    const alpha = await closedAlpha(40_000);
    const at = alpha.kit.clock.now();
    const text = 'Answer the review on T1.';
    assert.equal((await alpha.kit.run(['inbox', 'add', '--to', 'alpha', '--text', text, '--session', 'lead'])).code, EXIT.ok);
    const asks = new WakeAsks(alpha.kit.files, ASKS);
    await asks.post('alpha', { from: 'lead', text, at, by: { at: at + 10 * MS_PER_MINUTE, line: lineHash(inboxLineOf(new Date(at), 'lead', text)) } });
    const early = await idleOpen(alpha);
    assert.match(early.result.stdout[0] ?? '', /^KEPT app-alpha/);
    assert.deepEqual(early.argv, []);
    alpha.kit.clock.advance(10 * MS_PER_MINUTE);
    const { result, argv } = await idleOpen(alpha);
    assert.match(result.stdout[0] ?? '', /^REOPENED app-alpha \(session alpha\) for an urgent line from lead: /);
    assert.match((promptOf(argv) ?? '').split('\n')[1] ?? '', /^- \d\d:\d\d \S+ lead: Answer the review on T1\.$/);
    assert.deepEqual(await asks.read('alpha'), []);
  });

  it('keeps the urgent lines for the next pass when no terminal opens, and says when it could not take them', async () => {
    const printing = await closedAlpha(40_000, { ...TEAM, open: { terminal: 'print' } });
    const kept = await urgentLine(printing);
    const manual = await idleOpen(printing);
    assert.equal(manual.result.code, EXIT.failed);
    assert.equal((await kept.read('alpha')).length, 1);

    const alpha = await closedAlpha(40_000);
    const stuck = await urgentLine(alpha);
    const [ask] = await stuck.read('alpha');
    assert.ok(ask !== undefined);
    const files = new FaultyFiles(alpha.kit.files).fail('remove', join(ASKS, 'alpha', ask.name), systemError('EACCES', 'EACCES: permission denied'));
    const { result } = await idleOpen(alpha, undefined, files);
    assert.equal(result.code, 0, result.stdout.join('\n'));
    assert.match(result.stdout[0] ?? '', /^REOPENED .*; its urgent lines were not taken, so its tab wakes on them once more: EACCES: permission denied$/);
    assert.equal(actsOf(alpha)[0]?.['outcome'], 'done');
  });

  it("counts the reopen as the resumed tab's wake, so its wake check never wakes it again for the work it reads (T1616)", async () => {
    const alpha = await checkedBeforeWork();
    await handWork(alpha);
    const { result, argv } = await idleOpen(alpha);
    assert.equal(result.code, 0, [...result.stdout, ...result.stderr].join('\n'));
    assert.equal(resumedOf(argv), CLAUDE_SESSION);
    const state = await new WakeStore(alpha.kit.files, WAKES).read('alpha');
    assert.ok(state !== undefined);
    assert.deepEqual([state.tab, state.known, state.pending, state.lastWakeAt], [CLAUDE_SESSION, ['T1'], undefined, alpha.kit.clock.now()]);
    assert.deepEqual(await wakeCheck(alpha), WAITING);
    alpha.kit.clock.advance(2 * MS_PER_MINUTE);
    assert.deepEqual(await wakeCheck(alpha), WAITING, 'past the batch, still no wake for T1');
    assert.equal(alpha.kit.files.get(WAKE_LOG), undefined);
  });

  it('leaves the wake state to the wake check after a --prompt resume, and says when it could not write it', async () => {
    const prompted = await checkedBeforeWork();
    const before = prompted.kit.files.get(WAKE_STATE);
    await handWork(prompted);
    const opened = await open(prompted, ['--prompt', 'Answer the review on T1.']);
    ok(opened.result);
    assert.equal(resumedOf(opened.argv), CLAUDE_SESSION);
    assert.equal(prompted.kit.files.get(WAKE_STATE), before, 'its own first prompt may not read its list');

    const alpha = await checkedBeforeWork();
    await handWork(alpha);
    const files = new FaultyFiles(alpha.kit.files).fail('write', WAKE_STATE, systemError('EACCES', 'EACCES: permission denied'));
    const { result } = await idleOpen(alpha, undefined, files);
    assert.equal(result.code, 0, result.stdout.join('\n'));
    assert.match(result.stdout[0] ?? '', /^REOPENED .*; its wake state was not written, so its tab may wake once more for work it reads now: EACCES: permission denied$/);
  });
});
