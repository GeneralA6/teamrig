import { atom, read, update } from 'claude-code';
import type { Register, StateRef } from 'claude-code';
import type { TeamrigBand, TeamrigMeetingPanel, TeamrigUpdate } from '../types';
import { INSTALLED_PLUGINS_FILE, pluginsFolderOf } from '../dist/core/installed-plugins.js';
import { bandLine, ClearHand, liveAgentsOf, sameBand, TICK_MS } from '../dist/mod/clear-hand.js';
import { REFRESH_TIMEOUT_MS, RefreshHand, refreshCliArgv } from '../dist/mod/refresh-hand.js';
import { CHECK_MS, RELOAD_COMMAND, ReloadHand } from '../dist/mod/reload-hand.js';
import {
  SLASH_ARGUMENT_HINT,
  SLASH_COMMAND,
  SLASH_DESCRIPTION,
  SLASH_HOOK_FAILED,
  SlashHand,
  slashCliArgv,
  TIMEOUT_MS,
} from '../dist/mod/slash-hand.js';
import { MEETING_TICK_MS, MEETING_TIMEOUT_MS, MeetingHand, meetingCliArgv } from '../dist/mod/meeting-hand.js';
import {
  MEETING_PANEL_TICK_MS,
  MEETING_PANEL_TIMEOUT_MS,
  MeetingPanelHand,
  meetingPanelCliArgv,
  panelLayout,
  type MeetingPanelCard,
} from '../dist/mod/meeting-panel-hand.js';
import { WAKE_TICK_MS, WAKE_TIMEOUT_MS, WakeHand, wakeCliArgv } from '../dist/mod/wake-hand.js';
import {
  UPDATE_APPLY_TIMEOUT_MS,
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_EVERY_MS,
  UPDATE_FIRST_MS,
  UPDATE_WATCH_MS,
  UpdateHand,
  updateBandOf,
  updateCliArgv,
} from '../dist/mod/update-hand.js';

/**
 * teamrig's mod (built into dist from `src/mod`): the `/teamrig` command in every session, and seven hands in every
 * interactive tab.
 *
 * `/teamrig <command> [args]` (`slash-hand.ts`): runs the plugin's CLI as `hook slash-command` with the typed text,
 * the tab's session and the line's origin, and shows what it printed as the command's output: no model turn, no
 * tokens. A read runs at once; a write runs only when the person typed it, and asks first when the CLI adds this
 * tab's session to it (src/cli/commands/slash.ts). Registered in a headless `claude -p` too, which ends with the
 * command's exit code.
 *
 * The refresh's /clear (`clear-hand.ts`): once a session wrote its handover and stayed quiet, the hidden restart
 * runner asks its tab to run /clear. The hand looks for that ask each second. While Claude Code still lists a live
 * agent of the session (`$.agent.list()`: a helper or a teammate not completed, failed or killed), or will not list
 * them, it holds the ask through the teamrig CLI (`hook clear-claim --hold --why <reason>`) and runs nothing: the
 * runner then ends nothing and asks again once the session is quiet. Else it claims the ask (`hook clear-claim`; both check the
 * restart is still pending) and runs /clear the way the person would, so the tab and its process stay. A tab
 * without this mod (an older Claude Code, mods off) leaves the ask unclaimed, and the runner ends the process
 * instead, guarded only by what the transcript shows (helpers it started in the last 6 hours).
 *
 * Before it claims, the hand holds the /clear for the person, as the ask carries the team's config: while the
 * prompt box holds a draft; for `refresh.holdAfterActivityMinutes` after the person's last key in the prompt box or
 * prompt (typed, or through Remote Control); for 10 minutes after the band's Hold. Then the band above the prompt
 * counts `refresh.countdownSeconds` down, with `1: Refresh now` (the next ask is claimed, unless a draft or a live
 * helper holds it) and `2: Hold 10 min`, which a bare digit in an empty prompt box presses. Through every hold before
 * the count the band shows what holds the /clear, and the time the person's own hold has left, with the same
 * buttons but no digits, which stay the person's. The band's value is the session's `band` (types/index.d.ts),
 * written each time what it draws changes, so the drawing redraws.
 *
 * The reload after an install (`reload-hand.ts`): every 15 s the hand reads Claude Code's installed_plugins.json, and
 * once an install that applies to this tab changed, the file stood for 10 s and nothing in the plugin store changed for
 * 10 s (an install still copied), it runs /reload-plugins while no turn runs: at most one per 5 minutes, never two for the same installs. It keeps its last reload in the session's state,
 * so the module the reload loads keeps both. A plugin run from outside Claude Code's cache (`--plugin-dir`) has no
 * installed_plugins.json beside it and gets no reload hand; a tab without this mod still needs /reload-plugins.
 *
 * The wake (`wake-hand.ts`): an idle session sees new work only at its next prompt. Every 15 s while no turn runs,
 * the hand asks the CLI (`hook wake-check`) once the register changed, a batch fell due or 10 minutes passed. The
 * CLI wakes a session only for its own unblocked work at `wake.priority` (p1 by default; p1 only past its daily
 * budget or in quiet hours), once per task, batched, and logs each wake with its cost (src/wake/decide.ts). The hand
 * submits the CLI's prompt with `$.prompt.submit`, Claude Code's own call for a prompt: a turn under the plugin's
 * name, nothing typed into the terminal, the prompt box and any draft left alone. A toast shows what woke the tab
 * and the cost; a wake a prompt hook drops is logged (`hook wake-dropped`).
 *
 * A scheduled meeting's notification (`meeting-hand.ts`): every 30 s, a turn running or not, the hand asks the CLI
 * (`hook meeting-due`) once the team's meetings file changed, the next meeting's time came or 10 minutes passed. The
 * CLI marks each meeting due as notified under its lock, so one tab of the team sends it, and starts the OS
 * notification; the hand shows each one it sent as a toast in its tab too.
 *
 * The meeting's agenda panel (`meeting-panel-hand.ts`): every 15 s, a turn running or not, the hand asks the CLI
 * (`hook meeting-panel`) once the meeting file or a register the meeting covers changed, or 10 minutes passed. While
 * the owner meets the root team's lead, the lead's tab opens the `meeting-agenda` pane: a header with how many
 * cards are left and decided, then On the table (boxed), Up next and Decided, each card with its summary. The pane closes once the meeting
 * ends; a person's close keeps it closed until another meeting starts. The panel's value is the session's
 * `meetingPanel` (types/index.d.ts).
 *
 * The update notice (`update-hand.ts`): a minute after the module loads, then every 10 minutes, the hand asks the
 * CLI (`hook update-check`, which asks the network at most every 6 hours across the machine) whether a newer teamrig
 * or teamrig-pane is published than the one installed. While one is, and no refresh band is up, the band above the
 * prompt names it with Update (`hook update-apply`: Claude Code's own `plugin update`, which the reload hand then
 * loads) and Dismiss (`hook update-dismiss`: hidden until a newer version is out), plain buttons with no digits, in
 * green. A press shows "updating" at once, then "updated, reloading" for 30 s, or the failure in red with Update
 * again. Every 5 s the hand dates installed_plugins.json, and a change checks at once, so an update made in any tab
 * hides the band in every tab within seconds. The band's value is the session's `updateView` (types/index.d.ts).
 *
 * The refresh within a turn (`refresh-hand.ts`): the Stop hook asks for the handover only at a turn's end, so a long
 * turn reached Claude Code's compaction first. After a tool result of the main conversation, once the context Claude
 * Code reports reached the size the CLI named, the hand asks the CLI (`hook refresh-mid`) and adds its ask after the
 * tool's result: the model reads it, the person does not see it. Before Claude Code compacts the main conversation
 * on its own, or computes that summary ahead, the hand asks `hook compact-check` and skips the compaction, with the
 * line that says why, while the handover is asked for or written, up to `refresh.compactCeilingTokens`; past it, or
 * when the CLI fails, the compaction goes. A subagent's tools and compactions are left alone.
 */

/** The reload hand's last reload, kept in the session (types/index.d.ts). */
const RELOAD_STATE: StateRef<'teamrig', 'reload'> = { plugin: 'teamrig', key: 'reload' };

/** The band above the prompt while a refresh's /clear is near; null, no band (types/index.d.ts). */
const BAND = atom({ plugin: 'teamrig', key: 'band' } as const, null);

/**
 * The update band above the prompt while a newer plugin is published, installs or was installed; null, no band
 * (types/index.d.ts). A key of its own: a module from before T2514 left a value of another shape under `update`.
 */
const UPDATE = atom({ plugin: 'teamrig', key: 'updateView' } as const, null);

/** The meeting's agenda panel the pane draws; null, none (types/index.d.ts). */
const MEETING_PANEL = atom({ plugin: 'teamrig', key: 'meetingPanel' } as const, null);

/** The agenda pane's id and tab title. */
const MEETING_PANE = 'meeting-agenda';
const MEETING_PANE_TITLE = 'Meeting agenda';
/** The mark before each card's title: on the table, still to come, decided. */
const CARD_MARKS: Readonly<Record<MeetingPanelCard['mark'], string>> = { current: '▶', next: '·', done: '✓' };

/** The bands' Buttons, by the key a press names. */
const REFRESH_NOW_KEY = 'refresh-now';
const HOLD_KEY = 'hold-refresh';
const UPDATE_KEY = 'update-plugin';
const DISMISS_KEY = 'dismiss-update';

/** Whether two update bands draw the same. */
function sameUpdate(a: TeamrigUpdate | null, b: TeamrigUpdate | null | undefined): boolean {
  if (a === null || b === null || b === undefined) {
    return a === b;
  }
  const [left, right] = [updateBandOf(a), updateBandOf(b)];
  return left.text === right.text && left.color === right.color && left.buttons.join() === right.buttons.join();
}

/** A tick worth a debug line: an ask acted on (cleared, ending, held, declined, left while busy) or a failure, not the quiet ones. */
function worthLogging(result: { readonly kind: string }): boolean {
  return result.kind !== 'no ask' && result.kind !== 'overlap';
}

/** A wake look worth a debug line: a wake, a dropped one or a failure, not the quiet ones. */
function wakeWorthLogging(result: { readonly kind: string }): boolean {
  return result.kind === 'woke' || result.kind === 'dropped' || result.kind === 'failed';
}

/** A meeting look worth a debug line: notices sent or a failure, not the quiet ones. */
function meetingWorthLogging(result: { readonly kind: string }): boolean {
  return result.kind === 'notified' || result.kind === 'failed';
}

/** A panel look worth a debug line: the pane shown, closed or a failure, not the quiet ones. */
function meetingPanelWorthLogging(result: { readonly kind: string }): boolean {
  return result.kind === 'shown' || result.kind === 'off' || result.kind === 'failed';
}

/** A check worth a debug line: a reload run, refused, failed or held for an install still written. */
function reloadWorthLogging(result: { readonly kind: string }): boolean {
  return result.kind === 'reloaded' || result.kind === 'refused' || result.kind === 'failed' || result.kind === 'installing';
}

/** A refresh look worth a debug line: an ask or a failure, not the quiet ones. */
function refreshWorthLogging(result: { readonly kind: string }): boolean {
  return result.kind === 'asked' || result.kind === 'failed';
}

export const register: Register = (on) => {
  let clearHand: ClearHand | undefined;
  /** Writes the band's value when the clear hand's view of it changed; set with the hand. */
  let showBand: (() => Promise<void>) | undefined;
  let reloadHand: ReloadHand | undefined;
  let wakeHand: WakeHand | undefined;
  let meetingHand: MeetingHand | undefined;
  let meetingPanelHand: MeetingPanelHand | undefined;
  let refreshHand: RefreshHand | undefined;
  let updateHand: UpdateHand | undefined;
  /** Writes the update band's value when the update hand's shown update changed; set with the hand. */
  let showUpdate: (() => Promise<void>) | undefined;

  on('session.start', async ($, e, next) => {
    const started = await next(e);
    await $.command
      .register({ name: SLASH_COMMAND, description: SLASH_DESCRIPTION, argumentHint: SLASH_ARGUMENT_HINT })
      .catch((error: unknown) => {
        $.ui.log(`teamrig /${SLASH_COMMAND} not registered: ${String(error)}`, { to: 'debug' });
      });
    // session.start fires once per load of this module (never on /clear): one hand of each per loaded module.
    if (!e.isInteractive) {
      return started;
    }
    if (clearHand === undefined) {
      const cli = `${$.plugin.root}/dist/cli/main.js`;
      const active = new ClearHand({
        sessionId: () => $.session.id(),
        exists: (path: string) => $.fs.exists(path),
        read: (path: string) => $.fs.read(path),
        cli: async (args: readonly string[], stdin: string) => {
          const run = await $.process.run(['node', cli, ...args], { stdin });
          return { exitCode: run.exitCode, stdout: run.stdout };
        },
        liveAgents: async () => liveAgentsOf(await $.agent.list()),
        draft: async () => (await $.prompt.read()).text,
        clear: async () => {
          await $.command.run({ command: 'clear' });
        },
        now: () => Date.now(),
      });
      clearHand = active;
      let shown: TeamrigBand | undefined;
      const show = async (): Promise<void> => {
        const view = active.band();
        if (sameBand(view, shown)) {
          return;
        }
        try {
          await update($, BAND, () => view ?? null);
          shown = view;
        } catch (error) {
          $.ui.log(`teamrig refresh band: ${String(error)}`, { to: 'debug' });
        }
      };
      // A band the module loaded before this one left: this hand counts nothing yet.
      await update($, BAND, () => null);
      showBand = show;
      $.clock.every(TICK_MS, () => {
        void active.tick().then(async (result) => {
          if (worthLogging(result)) {
            $.ui.log(`teamrig refresh /clear: ${JSON.stringify(result)}`, { to: 'debug' });
          }
          await show();
        });
      });
    }
    const pluginsFolder = pluginsFolderOf($.plugin.root);
    if (reloadHand === undefined && pluginsFolder !== undefined) {
      const active = new ReloadHand({
        pluginsFolder,
        readInstalled: () => $.fs.read(`${pluginsFolder}/${INSTALLED_PLUGINS_FILE}`),
        changedAt: (path) => $.fs.stat(path).then(
          (found) => found.mtimeMs,
          () => undefined,
        ),
        foldersIn: (path) => $.fs.list(path).then(
          (entries) => entries.filter((entry) => entry.kind === 'dir').map((entry) => `${path}/${entry.name}`),
          () => [],
        ),
        projectRoot: () => $.session.root(),
        reload: async () => {
          const ran = await $.command.run({ command: RELOAD_COMMAND });
          return ran.text ?? '';
        },
        recall: async () => (await $.state.get(RELOAD_STATE)).value,
        remember: async (record) => {
          await $.state.set(RELOAD_STATE, record);
        },
        now: () => Date.now(),
      });
      reloadHand = active;
      void active.start().then(() => {
        $.clock.every(CHECK_MS, () => {
          void active.check().then((result) => {
            if (reloadWorthLogging(result)) {
              $.ui.log(`teamrig reload: ${JSON.stringify(result)}`, { to: 'debug' });
            }
          });
        });
      });
    }
    if (wakeHand === undefined) {
      const active = new WakeHand({
        sessionId: () => $.session.id(),
        cwd: () => $.session.cwd(),
        root: () => $.session.root(),
        cli: async (command, stdin, env, cwd) => {
          const run = await $.process.run(wakeCliArgv($.plugin.root, command), { cwd, env: { ...env }, stdin, timeoutMs: WAKE_TIMEOUT_MS });
          return { exitCode: run.exitCode, stdout: run.stdout };
        },
        changedAt: (path) => $.fs.stat(path).then(
          (found) => found.mtimeMs,
          () => undefined,
        ),
        submit: async (text) => {
          const submitted = await $.prompt.submit({ text });
          return submitted.drop;
        },
        toast: (text) => {
          $.ui.toast(text);
        },
        now: () => Date.now(),
      });
      wakeHand = active;
      $.clock.every(WAKE_TICK_MS, () => {
        void active.tick().then((result) => {
          if (wakeWorthLogging(result)) {
            $.ui.log(`teamrig wake: ${JSON.stringify(result)}`, { to: 'debug' });
          }
        });
      });
    }
    if (meetingHand === undefined) {
      const active = new MeetingHand({
        sessionId: () => $.session.id(),
        cwd: () => $.session.cwd(),
        root: () => $.session.root(),
        cli: async (stdin, env, cwd) => {
          const run = await $.process.run(meetingCliArgv($.plugin.root), { cwd, env: { ...env }, stdin, timeoutMs: MEETING_TIMEOUT_MS });
          return { exitCode: run.exitCode, stdout: run.stdout };
        },
        changedAt: (path) => $.fs.stat(path).then(
          (found) => found.mtimeMs,
          () => undefined,
        ),
        toast: (text, stayMs) => {
          if (stayMs === null) {
            $.ui.toast(text);
          } else {
            $.ui.toast(text, { timeoutMs: stayMs });
          }
        },
        now: () => Date.now(),
      });
      meetingHand = active;
      $.clock.every(MEETING_TICK_MS, () => {
        void active.tick().then((result) => {
          if (meetingWorthLogging(result)) {
            $.ui.log(`teamrig meeting: ${JSON.stringify(result)}`, { to: 'debug' });
          }
        });
      });
    }
    if (meetingPanelHand === undefined) {
      const active = new MeetingPanelHand({
        sessionId: () => $.session.id(),
        cwd: () => $.session.cwd(),
        root: () => $.session.root(),
        cli: async (stdin, env, cwd) => {
          const run = await $.process.run(meetingPanelCliArgv($.plugin.root), { cwd, env: { ...env }, stdin, timeoutMs: MEETING_PANEL_TIMEOUT_MS });
          return { exitCode: run.exitCode, stdout: run.stdout };
        },
        changedAt: (path) => $.fs.stat(path).then(
          (found) => found.mtimeMs,
          () => undefined,
        ),
        open: async () => {
          const opened = await $.ui.open({ id: MEETING_PANE, title: MEETING_PANE_TITLE });
          if (!opened.isPlaced) {
            $.ui.log(`teamrig meeting panel waits undrawn: ${opened.reason}`, { to: 'debug' });
          }
        },
        close: () => $.ui.close({ id: MEETING_PANE }),
        show: async (view) => {
          await update($, MEETING_PANEL, () => view);
        },
        now: () => Date.now(),
      });
      meetingPanelHand = active;
      $.clock.every(MEETING_PANEL_TICK_MS, () => {
        void active.tick().then((result) => {
          if (meetingPanelWorthLogging(result)) {
            $.ui.log(`teamrig meeting panel: ${JSON.stringify(result)}`, { to: 'debug' });
          }
        });
      });
    }
    if (refreshHand === undefined) {
      refreshHand = new RefreshHand({
        sessionId: () => $.session.id(),
        cwd: () => $.session.cwd(),
        root: () => $.session.root(),
        cli: async (command, stdin, env, cwd) => {
          const run = await $.process.run(refreshCliArgv($.plugin.root, command), { cwd, env: { ...env }, stdin, timeoutMs: REFRESH_TIMEOUT_MS });
          return { exitCode: run.exitCode, stdout: run.stdout };
        },
        now: () => Date.now(),
      });
    }
    if (updateHand === undefined) {
      const active = new UpdateHand({
        cli: async (command, stdin) => {
          const timeoutMs = command === 'apply' ? UPDATE_APPLY_TIMEOUT_MS : UPDATE_CHECK_TIMEOUT_MS;
          const run = await $.process.run(updateCliArgv($.plugin.root, command), { stdin, timeoutMs });
          return { exitCode: run.exitCode, stdout: run.stdout };
        },
        toast: (text) => {
          $.ui.toast(text);
        },
        changed: () => {
          void showUpdate?.();
        },
        // A plugin run from outside Claude Code's cache has no installed_plugins.json to watch.
        installedChangedAt: async () =>
          pluginsFolder === undefined
            ? undefined
            : $.fs.stat(`${pluginsFolder}/${INSTALLED_PLUGINS_FILE}`).then(
                (found) => found.mtimeMs,
                () => undefined,
              ),
        now: async () => $.clock.now(),
      });
      updateHand = active;
      let shown: TeamrigUpdate | null | undefined;
      const show = async (): Promise<void> => {
        const view = active.view(await $.clock.now()) ?? null;
        if (sameUpdate(view, shown)) {
          return;
        }
        try {
          await update($, UPDATE, () => view);
          shown = view;
        } catch (error) {
          $.ui.log(`teamrig update band: ${String(error)}`, { to: 'debug' });
        }
      };
      // A band the module loaded before this one left: this hand has checked nothing yet.
      await show();
      showUpdate = show;
      const check = (): void => {
        void active.tick().then(async (result) => {
          if (result.kind === 'failed') {
            $.ui.log(`teamrig update check: ${JSON.stringify(result)}`, { to: 'debug' });
          }
          await show();
        });
      };
      // A minute in, so a tab's start is left alone; then every 10 minutes on Claude Code's clock.
      $.clock.after(UPDATE_FIRST_MS, () => {
        check();
        $.clock.every(UPDATE_EVERY_MS, check);
      });
      // An install made by any tab hides the band here within seconds; the redraw also ends "updated" after 30 s.
      $.clock.every(UPDATE_WATCH_MS, () => {
        void active.watch().then(async (result) => {
          if (result.kind === 'changed' && result.tick.kind === 'failed') {
            $.ui.log(`teamrig update watch: ${JSON.stringify(result)}`, { to: 'debug' });
          }
          await show();
        });
      });
    }
    return started;
  });

  on('command.run', { command: SLASH_COMMAND }, async ($, e) => {
    const hand = new SlashHand({
      sessionId: () => $.session.id(),
      cwd: () => $.session.cwd(),
      root: () => $.session.root(),
      cli: (stdin, env, cwd) => $.process.run(slashCliArgv($.plugin.root), { cwd, env: { ...env }, stdin, timeoutMs: TIMEOUT_MS }),
      ask: (question, options) => $.ui.ask(question, options),
      status: (text) => $.ui.status(text),
    });
    return hand.answer(e.args, e.origin.kind);
  }).catch(() => ({ text: SLASH_HOOK_FAILED, exitCode: 1 }));

  on('turn.start', async (_$, e, next) => {
    clearHand?.turnStarted();
    void showBand?.();
    reloadHand?.turnStarted(e.turnId);
    wakeHand?.turnStarted(e.turnId);
    return next(e);
  });

  on('turn.complete', async (_$, e, next) => {
    clearHand?.turnEnded();
    reloadHand?.turnEnded(e.turnId);
    wakeHand?.turnEnded(e.turnId);
    return next(e);
  });

  // The person's keys in the prompt box hold the refresh's /clear a while, which its band counts.
  on('prompt.edit', async (_$, e, next) => {
    clearHand?.personActed();
    void showBand?.();
    return next(e);
  });

  // The person's prompt cancels the restart, which hides the band until the restart asks again.
  on('prompt.submit', async (_$, e, next) => {
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      clearHand?.promptSent();
      void showBand?.();
    }
    return next(e);
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e);
    }
    const view = await read($, BAND);
    const hand = clearHand;
    const { Box, Button, Text } = $.ui.resolve(e);
    // A refresh near is the more pressing band; the update waits under it.
    if (view === null || hand === undefined) {
      const shown = await read($, UPDATE);
      const updates = updateHand;
      if (shown === null || updates === undefined) {
        return next(e);
      }
      const drawn = updateBandOf(shown);
      const press = (action: () => Promise<{ readonly kind: string }>): void => {
        void action().then(async (result) => {
          if (result.kind === 'failed') {
            $.ui.log(`teamrig update band: ${JSON.stringify(result)}`, { to: 'debug' });
          }
          await showUpdate?.();
        });
      };
      // Plain buttons with no digits: an update never needs a key the person may be typing.
      const buttons = drawn.buttons.map((button) =>
        button === 'update'
          ? Button({ key: UPDATE_KEY, label: 'Update', plain: true, onPress: () => press(() => updates.apply()) })
          : Button({ key: DISMISS_KEY, label: 'Dismiss', plain: true, onPress: () => press(() => updates.dismiss()) }),
      );
      return Box({ flexDirection: 'row', gap: 2, children: [Text({ color: drawn.color, children: drawn.text }), ...buttons] });
    }
    // Only the count and its end arm the digits, once the person left the tab alone a while: while they work in
    // it, or a draft or a helper holds, a digit typed into the empty prompt box is theirs, and a click or the
    // band's focus presses the buttons.
    const armed = view.kind === 'counting' || view.kind === 'refreshing';
    const refreshNow = Button({
      key: REFRESH_NOW_KEY,
      ...(armed ? { hotkey: '1' } : {}),
      label: 'Refresh now',
      plain: true,
      onPress: () => {
        hand.refreshNow();
        void showBand?.();
      },
    });
    const hold = Button({
      key: HOLD_KEY,
      ...(armed ? { hotkey: '2' } : {}),
      label: 'Hold 10 min',
      plain: true,
      onPress: () => {
        hand.holdRefresh();
        void showBand?.();
      },
    });
    // "Refresh now" passes the count and the person's holds, never a draft's or a helper's; once the count ended
    // the /clear comes with the next ask, which Hold alone still stops.
    const buttons = view.kind === 'counting' || view.kind === 'waiting' ? [refreshNow, hold] : [hold];
    return Box({ flexDirection: 'row', gap: 2, children: [Text({ children: bandLine(view) }), ...buttons] });
  });

  on('ui.render', { component: 'Pane', requestId: MEETING_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    const view: TeamrigMeetingPanel | null = await read($, MEETING_PANEL);
    if (view === null) {
      return Text({ dimColor: true, children: 'No meeting is open.' });
    }
    // T2519: sections with gaps between them, and each card's summary under its title, so a vague title still says
    // what is to decide; the card on the table sits in a rounded box at the top.
    const layout = panelLayout(view);
    const cardOf = (card: MeetingPanelCard) => {
      const lines = [Text({ bold: card.mark !== 'done', dimColor: card.mark === 'done', children: `${CARD_MARKS[card.mark]} ${card.title}` })];
      if (card.summary !== null) {
        lines.push(Text({ wrap: 'wrap', children: card.summary }));
      }
      if (card.decision !== null) {
        lines.push(Text({ wrap: 'wrap', children: `Decided: ${card.decision}` }));
      }
      lines.push(Text({ dimColor: true, children: card.id }));
      return card.mark === 'current'
        ? Box({ flexDirection: 'column', borderStyle: 'round', paddingX: 1, children: lines })
        : Box({ flexDirection: 'column', paddingLeft: 2, children: lines });
    };
    const sections = layout.sections.map((section) =>
      Box({
        flexDirection: 'column',
        gap: 1,
        children: [Text({ bold: true, dimColor: true, children: section.heading }), ...section.cards.map(cardOf)],
      }),
    );
    return Box({ flexDirection: 'column', paddingX: 1, paddingY: 1, gap: 1, children: [Text({ bold: true, children: layout.header }), ...sections] });
  });

  // The person's close of the agenda pane keeps it closed until another meeting starts.
  on('ui.close', async (_$, e, next) => {
    if (e.id === MEETING_PANE && e.origin.kind === 'person') {
      meetingPanelHand?.personClosed();
    }
    return next(e);
  });

  on('tool.call', async ($, e, next) => {
    const result = await next(e);
    const hand = refreshHand;
    if (hand === undefined || e.agentId !== undefined || result.deny !== undefined) {
      return result;
    }
    const usage = await $.session.usage().catch(() => undefined);
    const tokens = usage?.context.tokens;
    if (tokens === undefined) {
      return result;
    }
    const look = await hand.afterTool(tokens);
    if (refreshWorthLogging(look)) {
      $.ui.log(`teamrig refresh within the turn: ${JSON.stringify(look)}`, { to: 'debug' });
    }
    return look.kind === 'asked' ? { ...result, context: [...(result.context ?? []), look.text] } : result;
  });

  on('session.compact', async ($, e, next) => {
    const hand = refreshHand;
    if (hand === undefined || e.agentId !== undefined || (e.trigger !== 'auto' && e.trigger !== 'precompute')) {
      return next(e);
    }
    // The figures Claude Code compacts on: its estimate of the context, against the compaction window.
    const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined);
    const breakdown = usage?.context.breakdown;
    const tokens = breakdown?.totalTokens ?? usage?.context.tokens;
    const window = breakdown?.rawMaxTokens ?? usage?.context.window;
    if (tokens === undefined || window === undefined) {
      return next(e);
    }
    const verdict = await hand.beforeCompact(tokens, window);
    if (verdict.kind === 'failed') {
      $.ui.log(`teamrig compaction check: ${JSON.stringify(verdict)}`, { to: 'debug' });
    }
    return verdict.kind === 'skip' ? { skip: verdict.reason } : next(e);
  });
};
