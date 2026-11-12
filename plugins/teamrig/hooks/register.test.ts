import type { On, RenderPropsOf, SessionCompacted, SessionContextBreakdown, SessionMessage, ToolCallResult } from 'claude-code';
import { describe, expect, mock, test, type Engine, type MockClock, type Mounted } from 'claude-code/testing';

/**
 * The mod's refresh wiring (`register.ts`) against the engine itself: the test's hooks stand for the engine
 * beneath it, answering the plugin's CLI runs, the session's figures, the tool or compaction it wraps, and the ask
 * files and prompt box of a refresh's /clear (the engine alone raises a key in the prompt box, prompt.edit: the
 * hand's answer to it, personActed, is tested in src/mod/clear-hand.test.ts). The hands' own rules are tested in src/mod/refresh-hand.test.ts and
 * src/mod/clear-hand.test.ts.
 */

const TAB = '0123abcd-0000-4000-8000-0000000000a1';
const ASK = 'teamrig: your context is 130k (refresh at 120k), so refresh within this turn.';
const SKIP = 'teamrig: the handover is asked for and the fresh start follows this turn, so compaction waits until 185k (now 170k)';
const PONG: ToolCallResult = { result: 'pong', text: 'pong' };
/** The main conversation as a compaction reads it, and the summary the engine beneath compacts it to. */
const MESSAGES: readonly SessionMessage[] = [{ role: 'user', text: 'ship T521', toolUses: [] }];
const COMPACTED: SessionCompacted = { messages: [{ role: 'user', text: 'Summary: T521 shipped.', toolUses: [] }] };
/** The clear hand's tick (src/mod/clear-hand.ts TICK_MS). */
const TICK = 1_000;
/** Where the tab's CLI says the restart runner posts its asks. */
const ASK_DIR = '/home/me/.teamrig/teams/app/state/clear-asks';
/** Whether the engine's fs call names this tab's ask: it hands the hooks the host's absolute path (C:\home\… on Windows). */
function isAskFile(path: string): boolean {
  return path.replaceAll('\\', '/').endsWith(`/clear-asks/${TAB}.ask`);
}
/** What the engine draws above the prompt when no plugin draws there. */
const ENGINE_ROW = "the engine's own row";
const REQUESTED_AT = '2030-01-08T09:59:59.000Z';
/** The band above the prompt as a terminal with no survey up lays it out. */
const ABOVE_PROMPT: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
};

/** What the tab's CLI answers each refresh command; a command left out exits 1. */
interface CliAnswers {
  readonly 'refresh-mid'?: unknown;
  readonly 'compact-check'?: unknown;
}

/** One run of the plugin's CLI: its command and what it read on stdin. */
interface CliRun {
  readonly command: string | undefined;
  readonly stdin: unknown;
}

/** Claude Code's estimate of the context against its compaction window, as /context breaks it down. */
function breakdownOf(totalTokens: number, rawMaxTokens: number): SessionContextBreakdown {
  return {
    categories: [],
    totalTokens,
    maxTokens: rawMaxTokens,
    rawMaxTokens,
    autocompactSource: 'model-default',
    percentage: Math.round((totalTokens / rawMaxTokens) * 100),
    gridRows: [],
    model: 'claude-test',
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    isAutoCompactEnabled: true,
    apiUsage: null,
  };
}

/**
 * An interactive tab whose last reply read 130k, and whose compaction estimate is 170k of a 200k window: starts
 * the session, which builds the hands, and records each run of the plugin's CLI.
 */
async function tab($: Engine, on: On, answers: CliAnswers, tool: ToolCallResult = PONG): Promise<CliRun[]> {
  const runs: CliRun[] = [];
  mock.clock(on, { now: 1_000_000 });
  on('session.id', () => ({ value: TAB }));
  on('session.cwd', () => ({ value: '/work/app/src' }));
  on('session.root', () => ({ value: '/work/app' }));
  on('ui.log', () => ({ value: undefined }));
  on('session.usage', (_$, e) => ({
    value: {
      startedAt: 0,
      context: { tokens: 130_000, window: 200_000, ...(e.breakdown === undefined ? {} : { breakdown: breakdownOf(170_000, 200_000) }) },
      rateLimits: [],
    },
  }));
  on('process.run', (_$, e) => {
    const command = e.argv.at(-1);
    runs.push({ command, stdin: JSON.parse(e.init?.stdin ?? 'null') });
    const answer = command === 'refresh-mid' || command === 'compact-check' ? answers[command] : undefined;
    return {
      value: {
        exitCode: answer === undefined ? 1 : 0,
        stdout: answer === undefined ? '' : `${JSON.stringify(answer)}\n`,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });
  on('tool.call', () => tool);
  on('session.compact', () => COMPACTED);
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true });
  return runs;
}

describe('the refresh within a turn', () => {
  test("adds the CLI's ask after a tool result of the main conversation, as the tab's session", async ($, on) => {
    const runs = await tab($, on, { 'refresh-mid': { kind: 'ask', text: ASK, nextAt: 154_000 } });
    const result = await $.tool.call({ tool: 'mcp__demo__ping', tool_use_id: 'toolu_1' });
    expect(result.context).toEqual([ASK]);
    expect(runs).toEqual([{ command: 'refresh-mid', stdin: { session_id: TAB, cwd: '/work/app/src', tokens: 130_000 } }]);
  });

  test('asks nothing after a subagent tool, a denied call or a quiet answer', async ($, on) => {
    const runs = await tab($, on, { 'refresh-mid': { kind: 'wait', nextAt: 140_000 } });
    expect((await $.tool.call({ tool: 'mcp__demo__ping', tool_use_id: 'toolu_1', agentId: 'agent-1' })).context).toBeUndefined();
    expect(runs).toEqual([]);
    expect((await $.tool.call({ tool: 'mcp__demo__ping', tool_use_id: 'toolu_2' })).context).toBeUndefined();
    expect(runs.length).toBe(1);
  });

  test('passes a denied call on as it is, with no ask', async ($, on) => {
    const runs = await tab($, on, { 'refresh-mid': { kind: 'ask', text: ASK, nextAt: 154_000 } }, { deny: 'not here' });
    expect(await $.tool.call({ tool: 'mcp__demo__ping', tool_use_id: 'toolu_1' })).toEqual({ deny: 'not here' });
    expect(runs).toEqual([]);
  });
});

describe('the compaction while a refresh is due', () => {
  test("skips Claude Code's own compaction of the main conversation while the CLI says so, on the figures it compacts on", async ($, on) => {
    const runs = await tab($, on, { 'compact-check': { kind: 'skip', reason: SKIP } });
    expect(await $.session.compact({ trigger: 'auto', messages: MESSAGES })).toEqual({ skip: SKIP });
    expect(await $.session.compact({ trigger: 'precompute', messages: MESSAGES })).toEqual({ skip: SKIP });
    expect(runs[0]).toEqual({ command: 'compact-check', stdin: { session_id: TAB, cwd: '/work/app/src', tokens: 170_000, window: 200_000 } });
  });

  test("lets the person's, a plugin's and a subagent's compaction go, and any the CLI cannot answer", async ($, on) => {
    const runs = await tab($, on, {});
    expect(await $.session.compact({ trigger: 'manual', messages: MESSAGES })).toEqual(COMPACTED);
    expect(await $.session.compact({ trigger: 'plugin', messages: MESSAGES })).toEqual(COMPACTED);
    expect(await $.session.compact({ trigger: 'auto', agentId: 'agent-1', messages: MESSAGES })).toEqual(COMPACTED);
    expect(runs).toEqual([]);
    expect(await $.session.compact({ trigger: 'auto', messages: MESSAGES })).toEqual(COMPACTED);
    expect(runs.length).toBe(1);
  });
});

/** A tab the restart runner asked to /clear: the clock its hand ticks on, what the hand ran, the ask it reads. */
interface AskedTab {
  readonly clock: MockClock;
  /** Each `hook clear-claim` the hand ran, by its flags: `['--hold', '--why', <reason>]` held the ask, `[]` claimed it. */
  readonly claims: string[][];
  /** How many times the hand ran /clear. */
  clears: number;
  /** The ask in the tab's file, as the runner last posted it. */
  ask: string;
  /** What the prompt box holds: empty, or a draft the person left unsent. */
  draft: string;
}

/** The runner's nth ask, each one new, carrying the team's defaults: a 20 s count, 5 min after a key, an ask each 15 s. */
function askOf(n: number): string {
  const askedAt = new Date(Date.parse(REQUESTED_AT) + n * 15_000).toISOString();
  return JSON.stringify({ team: 'app', id: 'alpha', at: REQUESTED_AT, askedAt, hold: { countdownMs: 20_000, afterActivityMs: 300_000 }, askEveryMs: 15_000 });
}

/**
 * An interactive tab the restart runner asked to /clear, its prompt box empty and no helper live: starts the
 * session, which builds the clear hand, whose CLI holds each ask the hand holds and hands it each one it claims.
 */
async function askedTab($: Engine, on: On): Promise<AskedTab> {
  const tab: AskedTab = { clock: mock.clock(on, { now: 1_000_000 }), claims: [], clears: 0, ask: askOf(1), draft: '' };
  on('session.id', () => ({ value: TAB }));
  on('session.cwd', () => ({ value: '/work/app' }));
  on('session.root', () => ({ value: '/work/app' }));
  on('ui.log', () => ({ value: undefined }));
  on('fs.exists', (_$, e) => ({ value: isAskFile(e.path) }));
  on('fs.read', (_$, e) => {
    if (!isAskFile(e.path)) {
      throw new Error(`no file ${e.path}`);
    }
    return { value: tab.ask };
  });
  on('agent.list', () => ({ value: [] }));
  on('prompt.read', () => ({ value: { text: tab.draft, cursor: tab.draft.length } }));
  on('process.run', (_$, e) => {
    const [command, ...flags] = e.argv.slice(3);
    if (command === 'clear-claim') {
      tab.claims.push(flags);
    }
    const answer = command === 'clear-dir' ? ASK_DIR : command === 'clear-claim' ? (flags.length === 0 ? 'taken' : 'held') : undefined;
    return {
      value: {
        exitCode: answer === undefined ? 1 : 0,
        stdout: `${answer ?? ''}\n`,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });
  on('command.run', (_$, e) => {
    if (e.command === 'clear') {
      tab.clears += 1;
    }
    return {};
  });
  on('prompt.edit', (_$, e) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }));
  on('prompt.submit', (_$, e) => ({ text: e.text }));
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ENGINE_ROW });
  });
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true });
  return tab;
}

/** The hand's hold of the first ask while the band counts down, with the reason a give-up names. */
const COUNTING = ['--hold', '--why', 'the band counts down: 20 s left'];

/** The tab's band above the prompt, once its hand read the runner's first ask and held it to count down. */
async function countingBand($: Engine, tab: AskedTab): Promise<Mounted<'terminal', 'AbovePrompt'>> {
  await tab.clock.advance(TICK);
  return $.ui.mount({ plugin: 'teamrig', surface: 'terminal', component: 'AbovePrompt', props: ABOVE_PROMPT });
}

/** The band's buttons in order, each by its key and the digit that presses it, undefined where none does. */
async function buttonsOf(band: Mounted<'terminal', 'AbovePrompt'>): Promise<(readonly [string | undefined, unknown])[]> {
  return (await band.findAll({ type: 'Button' })).map((button) => [button.key, button.props['hotkey']] as const);
}

describe("the band before a refresh's /clear", () => {
  test('counts down above the prompt, and Refresh now has the next ask claimed and /clear run', async ($, on) => {
    const tab = await askedTab($, on);
    const band = await countingBand($, tab);
    expect(tab.claims).toEqual([COUNTING]);
    expect((await band.find({ type: 'Text' }))?.text).toBe('teamrig: this session refreshes in 20 s, a fresh start from its handover');
    expect(await buttonsOf(band)).toEqual([['refresh-now', '1'], ['hold-refresh', '2']]);
    await band.press({ key: 'refresh-now' });
    expect((await band.find({ type: 'Text' }))?.text).toBe('teamrig: this session is refreshing, a fresh start from its handover');
    expect(await buttonsOf(band)).toEqual([['hold-refresh', '2']]);
    tab.ask = askOf(2);
    await tab.clock.advance(TICK);
    expect(tab.claims).toEqual([COUNTING, []]);
    expect(tab.clears).toBe(1);
    expect(await band.find({ type: 'Button' })).toBeUndefined();
  });

  test("counts the person's Hold down, which holds the next ask, its buttons leaving the digits to the person", async ($, on) => {
    const tab = await askedTab($, on);
    const band = await countingBand($, tab);
    await band.press({ key: 'hold-refresh' });
    const waiting = 'teamrig: this session refreshes from its handover; you pressed Hold, so it waits 10 min more';
    expect((await band.find({ type: 'Text' }))?.text).toBe(waiting);
    expect(await buttonsOf(band)).toEqual([['refresh-now', undefined], ['hold-refresh', undefined]]);
    tab.ask = askOf(2);
    await tab.clock.advance(TICK);
    expect(tab.claims).toEqual([COUNTING, ['--hold', '--why', 'the person pressed Hold: 10 min left']]);
    expect((await band.find({ type: 'Text' }))?.text).toBe(waiting);
    expect(tab.clears).toBe(0);
  });

  test('says a draft holds the /clear from the first ask on, before any count, with Hold alone and no digit', async ($, on) => {
    const tab = await askedTab($, on);
    tab.draft = 'half a thought';
    const band = await countingBand($, tab);
    expect(tab.claims).toEqual([['--hold', '--why', 'the prompt box holds an unsent draft']]);
    expect((await band.find({ type: 'Text' }))?.text).toBe('teamrig: this session refreshes from its handover once nothing holds it: the prompt box holds an unsent draft');
    expect(await buttonsOf(band)).toEqual([['hold-refresh', undefined]]);
  });

  test("hides at the person's prompt, not at a background task's", async ($, on) => {
    const tab = await askedTab($, on);
    const band = await countingBand($, tab);
    await $.prompt.submit({ text: 'the build finished', wait: false, origin: { kind: 'task-notification' } });
    await tab.clock.settle();
    expect(await band.find({ key: 'hold-refresh' })).not.toBeUndefined();
    await $.prompt.submit({ text: 'and now?', wait: false, origin: { kind: 'composer' } });
    await tab.clock.settle();
    expect(await band.find({ type: 'Button' })).toBeUndefined();
  });

  test('yields to a survey', async ($, on) => {
    const tab = await askedTab($, on);
    await tab.clock.advance(TICK);
    const band = await $.ui.mount({ plugin: 'teamrig', surface: 'terminal', component: 'AbovePrompt', props: { ...ABOVE_PROMPT, hasSurvey: true } });
    expect(await band.find({ type: 'Button' })).toBeUndefined();
    expect(await band.drawn()).toMatchObject({ type: 'Text', children: [ENGINE_ROW] });
  });
});

/** The update hand's first check, a minute after the mod loads (src/mod/update-hand.ts UPDATE_FIRST_MS). */
const FIRST_CHECK = 60_000;
const TEAMRIG_UPDATE = { plugin: 'teamrig', marketplace: 'teamrig', installed: '0.332.0', newest: '0.333.0' };
const PANE_UPDATE = { plugin: 'teamrig-pane', marketplace: 'teamrig-pane', installed: '0.40.0', newest: '0.41.0' };

/** A tab with no refresh asked: the clock, each `hook update-*` run with its stdin, and the toasts shown. */
interface UpdateTab {
  readonly clock: MockClock;
  readonly runs: CliRun[];
  readonly toasts: string[];
}

/** How long the band says an update is installed (src/mod/update-hand.ts UPDATED_SHOW_MS). */
const UPDATED_SHOW = 30_000;

/**
 * An interactive tab whose CLI tells of a newer teamrig and teamrig-pane, and updates or dismisses either, unless
 * `answers` gives a command another answer.
 */
async function updateTab($: Engine, on: On, answers: Readonly<Record<string, unknown>> = {}): Promise<UpdateTab> {
  const tab: UpdateTab = { clock: mock.clock(on, { now: 1_000_000 }), runs: [], toasts: [] };
  on('session.id', () => ({ value: TAB }));
  on('session.cwd', () => ({ value: '/work/app' }));
  on('session.root', () => ({ value: '/work/app' }));
  on('ui.log', () => ({ value: undefined }));
  on('ui.toast', (_$, e) => {
    tab.toasts.push(e.text);
    return { value: undefined };
  });
  on('fs.exists', () => ({ value: false }));
  on('process.run', (_$, e) => {
    const command = e.argv.at(-1);
    const stdin = e.init?.stdin;
    const given: Readonly<Record<string, unknown>> = {
      'update-check': { kind: 'notices', notices: [TEAMRIG_UPDATE, PANE_UPDATE] },
      'update-apply': { kind: 'applied', plugin: 'teamrig', version: '0.333.0' },
      'update-dismiss': { kind: 'dismissed' },
      ...answers,
    };
    const answer = command === undefined ? undefined : given[command];
    if (answer !== undefined) {
      tab.runs.push({ command, stdin: JSON.parse(stdin ?? 'null') });
    }
    return {
      value: {
        exitCode: answer === undefined ? 1 : 0,
        stdout: answer === undefined ? '' : `${JSON.stringify(answer)}\n`,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ENGINE_ROW });
  });
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true });
  return tab;
}

describe('the band telling of a newer plugin', () => {
  test('shows nothing before the first check, then names the update with Update and Dismiss, no digits', async ($, on) => {
    const tab = await updateTab($, on);
    const band = await $.ui.mount({ plugin: 'teamrig', surface: 'terminal', component: 'AbovePrompt', props: ABOVE_PROMPT });
    await tab.clock.advance(FIRST_CHECK - 1);
    expect(tab.runs).toEqual([]);
    expect(await band.drawn()).toMatchObject({ type: 'Text', children: [ENGINE_ROW] });
    await tab.clock.advance(1);
    expect(tab.runs).toEqual([{ command: 'update-check', stdin: {} }]);
    expect((await band.find({ type: 'Text' }))?.text).toBe('teamrig: teamrig 0.333.0 is out (you run 0.332.0)');
    expect(await buttonsOf(band)).toEqual([['update-plugin', undefined], ['dismiss-update', undefined]]);
  });

  test('draws the update in green', async ($, on) => {
    const tab = await updateTab($, on);
    await tab.clock.advance(FIRST_CHECK);
    const band = await $.ui.mount({ plugin: 'teamrig', surface: 'terminal', component: 'AbovePrompt', props: ABOVE_PROMPT });
    expect(await band.find({ type: 'Text' })).toMatchObject({ props: { color: 'success' } });
  });

  test('Update installs the shown plugin, says so with no buttons for 30 s, then shows the next update', async ($, on) => {
    const tab = await updateTab($, on);
    await tab.clock.advance(FIRST_CHECK);
    const band = await $.ui.mount({ plugin: 'teamrig', surface: 'terminal', component: 'AbovePrompt', props: ABOVE_PROMPT });
    await band.press({ key: 'update-plugin' });
    await tab.clock.settle();
    expect(tab.runs.at(-1)).toEqual({ command: 'update-apply', stdin: { plugin: 'teamrig' } });
    expect(tab.toasts).toEqual(['teamrig 0.333.0 installed: the tab reloads it']);
    expect((await band.find({ type: 'Text' }))?.text).toBe('teamrig: updated to teamrig 0.333.0, reloading');
    expect(await band.find({ type: 'Button' })).toBeUndefined();
    await tab.clock.advance(UPDATED_SHOW);
    expect((await band.find({ type: 'Text' }))?.text).toBe('teamrig: teamrig-pane 0.41.0 is out (you run 0.40.0)');
  });

  test('a failed Update shows why in red, with Update to try again', async ($, on) => {
    const tab = await updateTab($, on, { 'update-apply': { kind: 'failed', why: 'plugin update failed: offline' } });
    await tab.clock.advance(FIRST_CHECK);
    const band = await $.ui.mount({ plugin: 'teamrig', surface: 'terminal', component: 'AbovePrompt', props: ABOVE_PROMPT });
    await band.press({ key: 'update-plugin' });
    await tab.clock.settle();
    expect(await band.find({ type: 'Text' })).toMatchObject({
      text: 'teamrig: teamrig 0.333.0 update failed: plugin update failed: offline',
      props: { color: 'error' },
    });
    expect(await buttonsOf(band)).toEqual([['update-plugin', undefined], ['dismiss-update', undefined]]);
  });

  test('Dismiss hides the shown version, and the next check runs 10 minutes on', async ($, on) => {
    const tab = await updateTab($, on);
    await tab.clock.advance(FIRST_CHECK);
    const band = await $.ui.mount({ plugin: 'teamrig', surface: 'terminal', component: 'AbovePrompt', props: ABOVE_PROMPT });
    await band.press({ key: 'dismiss-update' });
    await tab.clock.settle();
    expect(tab.runs.at(-1)).toEqual({ command: 'update-dismiss', stdin: { plugin: 'teamrig', version: '0.333.0' } });
    expect((await band.find({ type: 'Text' }))?.text).toBe('teamrig: teamrig-pane 0.41.0 is out (you run 0.40.0)');
    await tab.clock.advance(10 * 60_000);
    expect(tab.runs.filter((each) => each.command === 'update-check').length).toBe(2);
  });
});

/** The meeting panel hand's tick and its longest wait (src/mod/meeting-panel-hand.ts). */
const PANEL_TICK = 15_000;
const PANEL_RECHECK = 10 * 60_000;
const MEETING_FILE = '/home/me/.teamrig/teams/app/state/meeting.json';
const OPEN_PANEL = {
  kind: 'open',
  watch: [MEETING_FILE],
  startedAt: '2030-01-08T10:00:00.000Z',
  items: [
    { id: 'T1', title: 'Pick the release day', settled: true, decision: 'Tuesday' },
    { id: 'bravo/T2', title: 'Raise the budget', settled: false, decision: null },
  ],
  current: 'bravo/T2',
  left: 1,
};
/** The agenda pane as a terminal lays it out. */
const AGENDA_PANE = {
  plugin: 'teamrig',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'meeting-agenda',
  props: { title: 'Meeting agenda', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const;

/** The lead's tab: what `hook meeting-panel` answers now, and the panes opened and closed under the mod. */
interface PanelTab {
  readonly clock: MockClock;
  answer: unknown;
  readonly opened: string[];
  readonly closed: string[];
}

async function panelTab($: Engine, on: On): Promise<PanelTab> {
  const tab: PanelTab = { clock: mock.clock(on, { now: 1_000_000 }), answer: OPEN_PANEL, opened: [], closed: [] };
  on('session.id', () => ({ value: TAB }));
  on('session.cwd', () => ({ value: '/work/app' }));
  on('session.root', () => ({ value: '/work/app' }));
  on('ui.log', () => ({ value: undefined }));
  on('fs.exists', () => ({ value: false }));
  on('ui.open', (_$, e) => {
    tab.opened.push(e.id);
    return { value: { isPlaced: true } };
  });
  on('ui.close', (_$, e) => {
    tab.closed.push(e.id);
    return { value: undefined };
  });
  on('process.run', (_$, e) => {
    const isPanel = e.argv.at(-1) === 'meeting-panel';
    return {
      value: {
        exitCode: isPanel ? 0 : 1,
        stdout: isPanel ? `${JSON.stringify(tab.answer)}\n` : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true });
  return tab;
}

describe("the meeting's agenda pane", () => {
  test('opens while a meeting is open and draws its cards, the decided one with its decision', async ($, on) => {
    const tab = await panelTab($, on);
    await tab.clock.advance(PANEL_TICK);
    expect(tab.opened).toEqual(['meeting-agenda']);
    const pane = await $.ui.mount(AGENDA_PANE);
    expect((await pane.findAll({ type: 'Text' })).map((row) => row.text)).toEqual([
      '1 to decide',
      '✓ T1 Pick the release day: Tuesday',
      '▶ bravo/T2 Raise the budget',
    ]);
    await pane.unmount();
  });

  test('closes once the meeting ends, and then draws no panel', async ($, on) => {
    const tab = await panelTab($, on);
    await tab.clock.advance(PANEL_TICK);
    tab.answer = { kind: 'off', why: 'no meeting is open', watch: [MEETING_FILE] };
    await tab.clock.advance(PANEL_RECHECK);
    expect(tab.closed).toEqual(['meeting-agenda']);
    const pane = await $.ui.mount(AGENDA_PANE);
    expect((await pane.find({ type: 'Text' }))?.text).toBe('No meeting is open.');
    await pane.unmount();
  });
});
