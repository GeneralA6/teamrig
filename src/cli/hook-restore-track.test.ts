import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Env } from '../core/home.ts';
import { MS_PER_HOUR } from '../core/time.ts';
import type { ChatWebhook } from '../core/webhook.ts';
import { dayProbePath, formatDayProbe, parseDayProbe, type DayProbe } from '../restore/day-probe.ts';
import type { RestoreEntry } from '../restore/entry.ts';
import { AUTH_FAILED, loginMarkerPath, parseLoginMarker, type LoginMarker } from '../restore/login.ts';
import { RestoreRegistry, restoreLogPath, restoreSessionsDir } from '../restore/registry.ts';
import { APP, CLAUDE_SESSION, CLI_PID, CliHarness, KIT, TEAM, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { FakeWebhook } from '../testing/fake-webhook.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { holdFileLock } from '../testing/held-file-lock.ts';
import { treeHarness } from '../testing/team-tree.ts';
import { apiErrorLine, promptLine, transcript } from '../testing/transcript-lines.ts';

const TRANSCRIPT = join(USER_HOME, '.claude', 'projects', 'work-app', `${CLAUDE_SESSION}.jsonl`);
const ENTRY_FILE = join(restoreSessionsDir(KIT), `${CLAUDE_SESSION}.json`);
const LAUNCHED: Env = { CLAUDE_PROJECT_DIR: APP, CLAUDE_CODE_ENTRYPOINT: 'cli', TEAMRIG_TEAM: 'app', TEAMRIG_SESSION: 'alpha' };
const MARKER_FILE = loginMarkerPath(KIT);
const TAB = `app/alpha (${CLAUDE_SESSION})`;

function payload(event: string, extra: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({ hook_event_name: event, session_id: CLAUDE_SESSION, cwd: join(APP, 'sub'), transcript_path: TRANSCRIPT, ...extra });
}

async function track(kit: CliHarness, stdin: string, env: Env = LAUNCHED): Promise<CliResult> {
  const result = await kit.run(['hook', 'restore-track'], { stdin, env, sessionProcesses: new FakeSessionProcesses(7000) });
  assert.deepEqual([result.code, result.stdout, result.stderr], [0, [], []], 'a tracker prints nothing and never fails a turn');
  return result;
}

async function entryOf(kit: CliHarness): Promise<RestoreEntry | undefined> {
  return new RestoreRegistry(kit.files, restoreSessionsDir(KIT)).read(CLAUDE_SESSION);
}

async function markerOf(kit: CliHarness): Promise<LoginMarker | undefined> {
  const text = await kit.files.read(MARKER_FILE);
  return text === undefined ? undefined : parseLoginMarker(text);
}

/** The restore log's login lines, each without its time. */
async function loginLines(kit: CliHarness): Promise<string[]> {
  const text = (await kit.files.read(restoreLogPath(KIT))) ?? '';
  return text
    .split('\n')
    .filter((line) => line.includes(' login: '))
    .map((line) => line.slice(line.indexOf(' ') + 1));
}

/** A tab's Claude session id, `index` of a dozen a day-start wake fails at once. */
function tabId(index: number): string {
  return `0123abcd-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`;
}

describe('hook restore-track', () => {
  it('records a session in a turn from its prompt: where it started, its Claude Code, team and session', async () => {
    const kit = new CliHarness();
    await track(kit, payload('UserPromptSubmit', { prompt: 'ship T1' }));
    const entry = await entryOf(kit);
    assert.equal(entry?.state, 'working');
    assert.equal(entry.projectDir, APP, 'the folder Claude Code started in wins over the current one');
    assert.equal(entry.transcriptPath, TRANSCRIPT);
    assert.equal(entry.entrypoint, 'cli');
    assert.equal(entry.pid, 7000);
    assert.deepEqual([entry.team, entry.session], ['app', 'alpha']);
    assert.equal(entry.createdAt, kit.clock.now());
  });

  it('marks it ready at the turn end, and errored after an API error', async () => {
    const kit = new CliHarness();
    await track(kit, payload('UserPromptSubmit'));
    await track(kit, payload('Stop', { stop_hook_active: false }));
    assert.equal((await entryOf(kit))?.state, 'ready');
    await track(kit, payload('StopFailure', { error: 'overloaded' }));
    assert.equal((await entryOf(kit))?.state, 'error');
  });

  it('records a session of no team, in the folder its payload names, and no id the environment garbles', async () => {
    const kit = new CliHarness(null, null);
    await track(kit, payload('SessionStart', { source: 'startup' }), { TEAMRIG_TEAM: 'Bad Team' });
    const entry = await entryOf(kit);
    assert.equal(entry?.projectDir, join(APP, 'sub'));
    assert.deepEqual([entry.team, entry.session, entry.entrypoint], [undefined, undefined, undefined]);
  });

  it("leaves a session in a turn as it was at a compaction's start, which comes mid-turn", async () => {
    const kit = new CliHarness();
    await track(kit, payload('UserPromptSubmit'));
    await track(kit, payload('SessionStart', { source: 'compact' }));
    assert.equal((await entryOf(kit))?.state, 'working');
    await track(kit, payload('SessionStart', { source: 'resume' }));
    assert.equal((await entryOf(kit))?.state, 'ready');
  });

  it('forgets a session at an end the person chose, and stamps any other end', async () => {
    const kit = new CliHarness();
    await track(kit, payload('UserPromptSubmit'));
    await track(kit, payload('SessionEnd', { reason: 'other' }));
    assert.equal((await entryOf(kit))?.endedAt, kit.clock.now());
    await track(kit, payload('SessionEnd', { reason: 'clear' }));
    assert.equal(await kit.files.read(ENTRY_FILE), undefined);
  });

  it('writes nothing for a payload of no session id, an event it does not track, or no folder', async () => {
    const kit = new CliHarness();
    await track(kit, JSON.stringify({ hook_event_name: 'Stop', session_id: '../../x', cwd: APP }));
    await track(kit, payload('PreToolUse', { tool_name: 'Bash' }));
    await track(kit, 'not json');
    await track(kit, JSON.stringify({ hook_event_name: 'Stop', session_id: CLAUDE_SESSION }), {});
    assert.deepEqual(await kit.files.list(restoreSessionsDir(KIT)), []);
  });

  it('lets the turn go on when the registry cannot be written', async () => {
    const kit = new CliHarness();
    const files = new FaultyFiles(kit.files).fail('write', ENTRY_FILE, systemError('EACCES'));
    const result = await kit.run(['hook', 'restore-track'], { stdin: payload('UserPromptSubmit'), env: LAUNCHED, files });
    assert.deepEqual([result.code, result.stdout, result.stderr], [0, [], []]);
    assert.equal(await entryOf(kit), undefined);
  });
});

describe('hook restore-track: the login', () => {
  it('marks the login expired and the tab stuck when a turn ends on Login expired', async () => {
    const kit = new CliHarness();
    await track(kit, payload('StopFailure', { error: AUTH_FAILED }));
    const now = kit.clock.now();
    assert.deepEqual(await markerOf(kit), { expiredAt: now, lastFailAt: now, recoveredAt: undefined, stranded: new Map([[CLAUDE_SESSION, now]]), pagedAt: undefined, probe: undefined, lastRetryAt: undefined, retried: new Map() });
    assert.deepEqual(await loginLines(kit), [`login: expired, ${TAB} ended its turn on Login expired; 1 tab(s) stuck`]);
    assert.equal((await entryOf(kit))?.state, 'error', 'the entry is kept as before');
  });

  it("reads the transcript's failed turn when the payload names no error", async () => {
    const kit = new CliHarness();
    await kit.files.write(TRANSCRIPT, transcript([promptLine('2030-01-08T09:59:50Z'), apiErrorLine('2030-01-08T10:00:00Z', CLAUDE_SESSION)]));
    await track(kit, payload('StopFailure'));
    assert.deepEqual([...((await markerOf(kit))?.stranded.keys() ?? [])], [CLAUDE_SESSION]);
  });

  it('writes no marker for a turn that failed on anything but the login', async () => {
    const kit = new CliHarness();
    await track(kit, payload('StopFailure', { error: 'overloaded' }));
    await kit.files.write(TRANSCRIPT, transcript([apiErrorLine('2030-01-08T10:00:00Z', CLAUDE_SESSION, 'server_error', 'API Error: 500')]));
    await track(kit, payload('StopFailure'));
    await track(kit, payload('Stop'));
    assert.equal(await kit.files.read(MARKER_FILE), undefined);
    assert.deepEqual(await loginLines(kit), []);
  });

  it('keeps one expiry when a dozen tabs fail at once, and logs it once and each other tab after it', async () => {
    const kit = new CliHarness();
    // The tabs' hooks take the marker's lock as this CLI: a holder it sees dead would be taken over, with no exclusion.
    kit.sessionProcesses.add({ pid: CLI_PID, parentPid: 1, name: 'node', commandLine: 'node teamrig hook' });
    const tabs = Array.from({ length: 12 }, (_, index) => tabId(index + 1));
    const start = kit.clock.now();
    const results = await Promise.all(tabs.map(async (tab) => kit.run(['hook', 'restore-track'], { stdin: payload('StopFailure', { session_id: tab, error: AUTH_FAILED }), env: LAUNCHED })));
    assert.deepEqual(results.map((result) => result.code), tabs.map(() => 0));
    const marker = await markerOf(kit);
    assert.equal(marker?.expiredAt, start);
    assert.deepEqual([...marker.stranded.keys()].sort(), tabs);
    const lines = await loginLines(kit);
    assert.deepEqual([lines.filter((line) => line.startsWith('login: expired,')).length, lines.length], [1, 12]);
    assert.match(lines.at(-1) ?? '', /; 12 tab\(s\) stuck$/);
  });

  it("logs the login working again at a later good turn end, and frees that tab", async () => {
    const kit = new CliHarness();
    await track(kit, payload('StopFailure', { error: AUTH_FAILED }));
    kit.clock.advance(6 * MS_PER_HOUR);
    await track(kit, payload('Stop'));
    const marker = await markerOf(kit);
    assert.deepEqual([marker?.recoveredAt, marker?.stranded.size], [kit.clock.now(), 0]);
    assert.equal((await loginLines(kit)).at(-1), `login: works again, ${TAB} answered; 0 tab(s) stuck`);
    await track(kit, payload('Stop'));
    assert.equal((await loginLines(kit)).length, 2, 'a good turn with the login working logs nothing');
  });

  it("updates the entry and exits 0 when the marker's lock stays busy", async () => {
    const kit = new CliHarness();
    await holdFileLock(kit, `${MARKER_FILE}.lock`);
    const result = await kit.run(['hook', 'restore-track'], { stdin: payload('StopFailure', { error: AUTH_FAILED }), env: LAUNCHED });
    assert.deepEqual([result.code, result.stdout, result.stderr], [0, [], []]);
    assert.equal((await entryOf(kit))?.state, 'error');
    assert.equal(await kit.files.read(MARKER_FILE), undefined);
  });

  it('writes the marker when the entry cannot be written', async () => {
    const kit = new CliHarness();
    const files = new FaultyFiles(kit.files).fail('write', ENTRY_FILE, systemError('EACCES'));
    const result = await kit.run(['hook', 'restore-track'], { stdin: payload('StopFailure', { error: AUTH_FAILED }), env: LAUNCHED, files });
    assert.deepEqual([result.code, result.stdout, result.stderr], [0, [], []]);
    assert.equal(await entryOf(kit), undefined);
    assert.equal((await markerOf(kit))?.stranded.has(CLAUDE_SESSION), true);
  });
});

/** The restore log's API error lines, each without its time. */
async function apiErrorLines(kit: CliHarness): Promise<string[]> {
  const text = (await kit.files.read(restoreLogPath(KIT))) ?? '';
  return text
    .split('\n')
    .filter((line) => line.includes(' api-error: '))
    .map((line) => line.slice(line.indexOf(' ') + 1));
}

/** A tab whose turn failed on `code`, its entry then given `retries` retries by the wake check. */
async function retriedTab(kit: CliHarness, code: string, retries: number): Promise<void> {
  await track(kit, payload('StopFailure', { error: code }));
  const entry = await entryOf(kit);
  assert.ok(entry?.apiError !== undefined, 'the failed turn records its error');
  await new RestoreRegistry(kit.files, restoreSessionsDir(KIT)).write({ ...entry, apiError: { ...entry.apiError, retries, retriedAt: kit.clock.now() } });
}

describe('hook restore-track: a transient API error', () => {
  it('logs the tab left for the person when its turn fails again after the last retry', async () => {
    const kit = new CliHarness();
    await retriedTab(kit, 'server_error', 3);
    assert.deepEqual(await apiErrorLines(kit), [], 'the first failure is for the wake check to retry');
    kit.clock.advance(MS_PER_HOUR);
    await track(kit, payload('StopFailure', { error: 'server_error' }));
    assert.deepEqual(await apiErrorLines(kit), [`api-error: gave up on ${TAB}: its turn ended on server_error after 3 retries`]);
    assert.deepEqual((await entryOf(kit))?.apiError, { code: 'server_error', failedAt: kit.clock.now(), retries: 3, retriedAt: kit.clock.now() - MS_PER_HOUR });
  });

  it('logs nothing while a retry is left, for an error no retry cures, or at a good turn end', async () => {
    const cases: ReadonlyArray<readonly [string, number, string]> = [
      ['overloaded', 2, 'StopFailure'],
      ['rate_limit', 3, 'StopFailure'],
      ['server_error', 3, 'Stop'],
    ];
    for (const [code, retries, next] of cases) {
      const kit = new CliHarness();
      await retriedTab(kit, code, retries);
      await track(kit, payload(next, next === 'Stop' ? { stop_hook_active: false } : { error: code }));
      assert.deepEqual(await apiErrorLines(kit), [], `${code} after ${retries} retries, then ${next}`);
    }
    const kit = new CliHarness();
    await retriedTab(kit, 'server_error', 3);
    await track(kit, payload('Stop', { stop_hook_active: false }));
    assert.equal((await entryOf(kit))?.apiError, undefined, 'a good turn clears the count');
  });
});

const PROBE_FILE = dayProbePath(KIT);

/** A day-start probe `tab` claimed just now, with no reply yet. */
async function probeClaimed(kit: CliHarness, tab: string): Promise<DayProbe> {
  const probe: DayProbe = { moment: kit.clock.now() - 2_000, tab, at: kit.clock.now(), releasedAt: undefined };
  await kit.files.write(PROBE_FILE, formatDayProbe(probe));
  return probe;
}

async function probeOf(kit: CliHarness): Promise<DayProbe | undefined> {
  const text = await kit.files.read(PROBE_FILE);
  return text === undefined ? undefined : parseDayProbe(text);
}

describe('hook restore-track: the day-start probe', () => {
  it("is released at the probe tab's first tool end, and logged", async () => {
    const kit = new CliHarness();
    await probeClaimed(kit, CLAUDE_SESSION);
    kit.clock.advance(12_000);
    await track(kit, payload('PostToolUse'));
    assert.equal((await probeOf(kit))?.releasedAt, kit.clock.now());
    const text = (await kit.files.read(restoreLogPath(KIT))) ?? '';
    assert.match(text, new RegExp(`day-probe: released, ${TAB.replace(/[()]/g, '\\$&')} ran a tool 12 s after the claim\\n$`));
  });

  it("stays out at another tab's or a helper's tool end, and is released by any tab's good turn end", async () => {
    const kit = new CliHarness();
    await probeClaimed(kit, tabId(1));
    kit.clock.advance(5_000);
    await track(kit, payload('PostToolUse'));
    await track(kit, payload('PostToolUse', { session_id: tabId(1), agent_id: 'helper-1' }));
    assert.equal((await probeOf(kit))?.releasedAt, undefined);
    await track(kit, payload('Stop'));
    assert.equal((await probeOf(kit))?.releasedAt, kit.clock.now());
  });
});

const HOOK_FILE = '/chat/hook';
const HOOK_URL = 'https://chat.example/x';
const PAGED_BY_FILE = "login: paged the owner through app's alerts.pageWebhookFile";

interface FailOptions {
  readonly env?: Env;
  readonly stdin?: string;
  readonly timeZone?: string;
}

/** A turn of the tab that ends on Login expired, its hook posting to `webhook`. */
async function failTurn(kit: CliHarness, webhook: ChatWebhook, { env = LAUNCHED, stdin = payload('StopFailure', { error: AUTH_FAILED }), timeZone = 'UTC' }: FailOptions = {}): Promise<void> {
  const result = await kit.run(['hook', 'restore-track'], { stdin, env, webhook, timeZone });
  assert.deepEqual([result.code, result.stdout, result.stderr], [0, [], []], 'a page never fails a turn');
}

/** The harness with app's alerts naming a page webhook file that holds the URL. */
async function pagedHarness(): Promise<CliHarness> {
  const kit = new CliHarness({ ...TEAM, alerts: { pageWebhookFile: HOOK_FILE } });
  await kit.files.write(HOOK_FILE, `\n${HOOK_URL}\n`);
  return kit;
}

describe("hook restore-track: the owner's page", () => {
  it("pages the owner once when a dozen tabs fail at once, through the URL the team's file holds", async () => {
    const kit = await pagedHarness();
    kit.sessionProcesses.add({ pid: CLI_PID, parentPid: 1, name: 'node', commandLine: 'node teamrig hook' });
    const webhook = new FakeWebhook();
    const tabs = Array.from({ length: 12 }, (_, index) => tabId(index + 1));
    // The clock moves while the tabs wait for the marker's lock: the claim is the first failure's.
    const start = kit.clock.now();
    await Promise.all(tabs.map(async (tab) => failTurn(kit, webhook, { stdin: payload('StopFailure', { session_id: tab, error: AUTH_FAILED }) })));
    assert.deepEqual(webhook.posts, [{ url: HOOK_URL, content: 'Claude login expired: app/alpha ended its turn on Login expired at 10:00 UTC. Run /login in any tab; teamrig holds the day-start wakes and retries the stuck tabs once the login works.' }]);
    assert.equal((await markerOf(kit))?.pagedAt, start);
    const lines = await loginLines(kit);
    assert.deepEqual([lines.filter((line) => line === PAGED_BY_FILE).length, lines.length], [1, 13]);
  });

  it('pages no more for a later failure of the same expiry, and anew for the next expiry', async () => {
    const kit = await pagedHarness();
    const webhook = new FakeWebhook();
    await failTurn(kit, webhook);
    kit.clock.advance(MS_PER_HOUR);
    await failTurn(kit, webhook);
    assert.equal(webhook.posts.length, 1);
    kit.clock.advance(MS_PER_HOUR);
    await track(kit, payload('Stop'));
    kit.clock.advance(MS_PER_HOUR);
    await failTurn(kit, webhook);
    assert.equal(webhook.posts.length, 2, 'the login worked again in between');
  });

  it('logs a failed page and gives its claim back, so the next failure pages', async () => {
    const kit = await pagedHarness();
    await failTurn(kit, new FakeWebhook('the webhook answered HTTP 500'));
    assert.equal((await loginLines(kit)).at(-1), 'login: the page to the owner failed (the webhook answered HTTP 500); the next failure pages');
    assert.equal((await markerOf(kit))?.pagedAt, undefined);
    kit.clock.advance(MS_PER_HOUR);
    const webhook = new FakeWebhook();
    await failTurn(kit, webhook);
    assert.equal(webhook.posts.length, 1);
    assert.equal((await loginLines(kit)).at(-1), PAGED_BY_FILE);
  });

  it('pages through the URL the environment variable alerts.pageWebhookEnv names holds', async () => {
    const kit = new CliHarness({ ...TEAM, alerts: { pageWebhookEnv: 'CHAT_PAGE_URL' } });
    const unset = new FakeWebhook();
    await failTurn(kit, unset);
    assert.deepEqual(unset.posts, []);
    assert.equal((await loginLines(kit)).at(-1), 'login: the page to the owner failed (alerts.pageWebhookEnv names CHAT_PAGE_URL, which is not set); the next failure pages');
    kit.clock.advance(MS_PER_HOUR);
    const webhook = new FakeWebhook();
    await failTurn(kit, webhook, { env: { ...LAUNCHED, CHAT_PAGE_URL: 'https://chat.example/env' } });
    assert.deepEqual(webhook.posts.map((post) => post.url), ['https://chat.example/env']);
    assert.equal((await loginLines(kit)).at(-1), "login: paged the owner through app's alerts.pageWebhookEnv");
  });

  it("names neither the file's path nor a URL when the file is missing", async () => {
    const kit = new CliHarness({ ...TEAM, alerts: { pageWebhookFile: HOOK_FILE, pageWebhookEnv: 'CHAT_PAGE_URL' } });
    const webhook = new FakeWebhook();
    await failTurn(kit, webhook, { env: { ...LAUNCHED, CHAT_PAGE_URL: 'https://chat.example/env' } });
    assert.deepEqual(webhook.posts, [], 'the file key wins over the environment key');
    const log = (await kit.files.read(restoreLogPath(KIT))) ?? '';
    assert.match(log, /login: the page to the owner failed \(the file alerts\.pageWebhookFile names is missing or empty\)/);
    assert.equal(log.includes(HOOK_FILE) || log.includes('chat.example'), false);
  });

  it('pages no one for a tab of no team, and claims no page for it', async () => {
    const kit = await pagedHarness();
    const webhook = new FakeWebhook();
    await failTurn(kit, webhook, { env: { CLAUDE_PROJECT_DIR: APP } });
    assert.deepEqual(webhook.posts, []);
    assert.equal((await markerOf(kit))?.pagedAt, undefined);
  });

  it("pages through a team above's key, with the time on the tab's own team clock", async () => {
    const kit = await treeHarness({ timeZone: 'UTC', alerts: { pageWebhookFile: HOOK_FILE } });
    await kit.files.write(HOOK_FILE, HOOK_URL);
    const webhook = new FakeWebhook();
    await failTurn(kit, webhook, { env: { CLAUDE_PROJECT_DIR: APP, TEAMRIG_TEAM: 'ui', TEAMRIG_SESSION: 'pixel' }, timeZone: 'Asia/Jerusalem' });
    assert.deepEqual(webhook.posts.map((post) => post.content), ['Claude login expired: ui/pixel ended its turn on Login expired at 12:00 IST. Run /login in any tab; teamrig holds the day-start wakes and retries the stuck tabs once the login works.']);
    assert.equal((await loginLines(kit)).at(-1), PAGED_BY_FILE);
  });

  it('names a tab its launch gave no session as a tab of its team', async () => {
    const kit = await pagedHarness();
    const webhook = new FakeWebhook();
    await failTurn(kit, webhook, { env: { CLAUDE_PROJECT_DIR: APP, TEAMRIG_TEAM: 'app' } });
    assert.match(webhook.posts[0]?.content ?? '', /^Claude login expired: a tab of team app ended its turn/);
  });

  it('pages for a turn whose failure only the transcript records', async () => {
    const kit = await pagedHarness();
    await kit.files.write(TRANSCRIPT, transcript([promptLine('2030-01-08T09:59:50Z'), apiErrorLine('2030-01-08T10:00:00Z', CLAUDE_SESSION)]));
    const webhook = new FakeWebhook();
    await failTurn(kit, webhook, { stdin: payload('StopFailure') });
    assert.equal(webhook.posts.length, 1);
  });
});
