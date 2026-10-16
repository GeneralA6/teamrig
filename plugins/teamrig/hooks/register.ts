import type { Register } from 'claude-code';
import { ClearHand, TICK_MS } from '../dist/mod/clear-hand.js';

/**
 * teamrig's mod: the tab's side of the automatic context refresh. Once a session wrote its handover and
 * stayed quiet, the hidden restart runner asks its tab to run /clear. In every interactive tab a hand
 * (`src/mod/clear-hand.ts`, built into dist) looks for that ask each second, claims it through the
 * teamrig CLI (`hook clear-claim`, which checks the restart is still pending) and runs /clear the way
 * the person would, so the tab and its process stay. A tab without this mod (an older Claude Code, mods
 * off) leaves the ask unclaimed, and the runner ends the process instead.
 */

/** A tick worth a debug line: an ask acted on or a failure, not the quiet ones. */
function worthLogging(result: { readonly kind: string }): boolean {
  return result.kind !== 'no ask' && result.kind !== 'overlap';
}

export const register: Register = (on) => {
  let hand: ClearHand | undefined;

  on('session.start', async ($, e, next) => {
    const started = await next(e);
    // A /clear starts the session again: one hand per loaded module, and it reads the new session id.
    if (hand !== undefined || !e.isInteractive) {
      return started;
    }
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
    hand = active;
    $.clock.every(TICK_MS, () => {
      void active.tick().then((result) => {
        if (worthLogging(result)) {
          $.ui.log(`teamrig refresh /clear: ${JSON.stringify(result)}`, { to: 'debug' });
        }
      });
    });
    return started;
  });

  on('turn.start', async (_$, e, next) => {
    hand?.turnStarted();
    return next(e);
  });

  on('turn.complete', async (_$, e, next) => {
    hand?.turnEnded();
    return next(e);
  });
};
