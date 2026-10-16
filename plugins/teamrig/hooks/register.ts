import type { Register, StateRef } from 'claude-code';
import { ClearHand, TICK_MS } from '../dist/mod/clear-hand.js';
import { CHECK_MS, installedPluginsFileOf, RELOAD_COMMAND, ReloadHand } from '../dist/mod/reload-hand.js';

/**
 * teamrig's mod: two hands in every interactive tab (built into dist from `src/mod`).
 *
 * The refresh's /clear (`clear-hand.ts`): once a session wrote its handover and stayed quiet, the hidden restart
 * runner asks its tab to run /clear. The hand looks for that ask each second, claims it through the teamrig CLI
 * (`hook clear-claim`, which checks the restart is still pending) and runs /clear the way the person would, so the
 * tab and its process stay. A tab without this mod (an older Claude Code, mods off) leaves the ask unclaimed, and
 * the runner ends the process instead.
 *
 * The reload after an install (`reload-hand.ts`): every 15 s the hand reads Claude Code's installed_plugins.json, and
 * once an install that applies to this tab changed and the file stood for 10 s, it runs /reload-plugins while no turn
 * runs: at most one per 5 minutes, never two for the same installs. It keeps its last reload in the session's state,
 * so the module the reload loads keeps both. A plugin run from outside Claude Code's cache (`--plugin-dir`) has no
 * installed_plugins.json beside it and gets no reload hand; a tab without this mod still needs /reload-plugins.
 */

/** The reload hand's last reload, kept in the session (types/index.d.ts). */
const RELOAD_STATE: StateRef<'teamrig', 'reload'> = { plugin: 'teamrig', key: 'reload' };

/** A tick worth a debug line: an ask acted on or a failure, not the quiet ones. */
function worthLogging(result: { readonly kind: string }): boolean {
  return result.kind !== 'no ask' && result.kind !== 'overlap';
}

/** A check worth a debug line: a reload run, refused or failed. */
function reloadWorthLogging(result: { readonly kind: string }): boolean {
  return result.kind === 'reloaded' || result.kind === 'refused' || result.kind === 'failed';
}

export const register: Register = (on) => {
  let clearHand: ClearHand | undefined;
  let reloadHand: ReloadHand | undefined;

  on('session.start', async ($, e, next) => {
    const started = await next(e);
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
    return started;
  });

  on('turn.start', async (_$, e, next) => {
    clearHand?.turnStarted();
    reloadHand?.turnStarted(e.turnId);
    return next(e);
  });

  on('turn.complete', async (_$, e, next) => {
    clearHand?.turnEnded();
    reloadHand?.turnEnded(e.turnId);
    return next(e);
  });
};
