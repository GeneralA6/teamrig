import type { Register, StateRef } from 'claude-code';
import { installedPluginsFileOf } from '../dist/core/installed-plugins.js';
import { ClearHand, liveAgentsOf, TICK_MS } from '../dist/mod/clear-hand.js';
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
import { WAKE_TICK_MS, WAKE_TIMEOUT_MS, WakeHand, wakeCliArgv } from '../dist/mod/wake-hand.js';

/**
 * teamrig's mod (built into dist from `src/mod`): the `/teamrig` command in every session, and four hands in every
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
 * them, it holds the ask through the teamrig CLI (`hook clear-claim --hold`) and runs nothing: the runner then ends
 * nothing and asks again once the session is quiet. Else it claims the ask (`hook clear-claim`; both check the
 * restart is still pending) and runs /clear the way the person would, so the tab and its process stay. A tab
 * without this mod (an older Claude Code, mods off) leaves the ask unclaimed, and the runner ends the process
 * instead, guarded only by what the transcript shows (helpers it started in the last 6 hours).
 *
 * The reload after an install (`reload-hand.ts`): every 15 s the hand reads Claude Code's installed_plugins.json, and
 * once an install that applies to this tab changed and the file stood for 10 s, it runs /reload-plugins while no turn
 * runs: at most one per 5 minutes, never two for the same installs. It keeps its last reload in the session's state,
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

/** A tick worth a debug line: an ask acted on (cleared, held, declined, left while busy) or a failure, not the quiet ones. */
function worthLogging(result: { readonly kind: string }): boolean {
  return result.kind !== 'no ask' && result.kind !== 'overlap';
}

/** A wake look worth a debug line: a wake, a dropped one or a failure, not the quiet ones. */
function wakeWorthLogging(result: { readonly kind: string }): boolean {
  return result.kind === 'woke' || result.kind === 'dropped' || result.kind === 'failed';
}

/** A check worth a debug line: a reload run, refused or failed. */
function reloadWorthLogging(result: { readonly kind: string }): boolean {
  return result.kind === 'reloaded' || result.kind === 'refused' || result.kind === 'failed';
}

/** A refresh look worth a debug line: an ask or a failure, not the quiet ones. */
function refreshWorthLogging(result: { readonly kind: string }): boolean {
  return result.kind === 'asked' || result.kind === 'failed';
}

export const register: Register = (on) => {
  let clearHand: ClearHand | undefined;
  let reloadHand: ReloadHand | undefined;
  let wakeHand: WakeHand | undefined;
  let refreshHand: RefreshHand | undefined;

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
        clear: async () => {
          await $.command.run({ command: 'clear' });
        },
        now: () => Date.now(),
      });
      clearHand = active;
      $.clock.every(TICK_MS, () => {
        void active.tick().then((result) => {
          if (worthLogging(result)) {
            $.ui.log(`teamrig refresh /clear: ${JSON.stringify(result)}`, { to: 'debug' });
          }
        });
      });
    }
    const installedFile = installedPluginsFileOf($.plugin.root);
    if (reloadHand === undefined && installedFile !== undefined) {
      const active = new ReloadHand({
        readInstalled: () => $.fs.read(installedFile),
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
