import { KIT_NAME } from '../../core/home.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { postLine } from '../../inbox/inbox.ts';
import { refreshPrompt } from '../../open/prompt.ts';
import { ClearAsks, clearAskDir } from '../../refresh/clear-asks.ts';
import { runRestart, type RestartResult } from '../../refresh/restart.ts';
import { RefreshStore } from '../../refresh/store.ts';
import { RestoreRegistry, restoreSessionsDir } from '../../restore/registry.ts';
import { onePositional, requiredFlag, UsageError, type ParsedArgs } from '../args.ts';
import { openKit, requireConfig, rosterOf } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { inboxDepsOf } from './inbox.ts';
import { idFlag, openSessionTab } from './open.ts';

/** What the session must know about its restart, as an inbox line: why none happened, or what failed after it. */
function inboxLineOf(result: RestartResult): string | undefined {
  switch (result.kind) {
    case 'cancelled':
    case 'cleared':
      return undefined;
    case 'failed':
      return `the automatic restart did not happen: ${result.why}; type /clear for a fresh start`;
    case 'restarted':
      switch (result.endCommand?.kind) {
        case undefined:
        case 'done':
          return undefined;
        case 'missing':
          return 'you were restarted, but refresh.endCommand was not found, so the hooks a hard end skips did not run';
        case 'failed':
          return `you were restarted, but refresh.endCommand failed (${result.endCommand.error}), so the hooks a hard end skips did not run`;
      }
  }
}

function resultLineOf(result: RestartResult, name: string): string {
  switch (result.kind) {
    case 'cancelled':
      return `CANCELLED the restart of ${name}: ${result.why}`;
    case 'failed':
      return `FAILED the restart of ${name}: ${result.why}`;
    case 'cleared':
      return `CLEARED ${name}: its tab ran /clear`;
    case 'restarted':
      return `RESTARTED ${name} in ${result.where === 'same tab' ? 'the same tab' : 'a new tab'}`;
  }
}

/**
 * `restart <id> --team <team> --at <time> --project <dir>`: the automatic context refresh's restart,
 * which the Stop hook starts hidden once the session's handover is written (`runRestart`): the tab's mod
 * runs /clear when it claims the ask in time, else the session's process is ended. A new tab,
 * when one is needed, opens in the project folder the way `open`'s does. What the session must know
 * goes to its inbox, which it reads at its next prompt or start; exit 1 when no restart happened.
 */
export async function restart(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const id = idFlag('session', onePositional(args, 'id'));
  const team = idFlag('--team', requiredFlag(args.flags, 'team'));
  const at = requiredFlag(args.flags, 'at');
  if (Number.isNaN(Date.parse(at))) {
    throw new UsageError(`--at "${at}" is not a time`);
  }
  const project = requiredFlag(args.flags, 'project');
  const kit = await openKit(runtime, team);
  const config = requireConfig(kit, runtime, 'read');
  const roster = await rosterOf(runtime, kit, config);
  const name = roster.nameOf(id) ?? id;
  const store = new RefreshStore(runtime.files, kit.paths);
  if (!config.refresh.enabled || !config.refresh.autoRestart) {
    await store.clearRestart(id);
    runtime.out.stdout(resultLineOf({ kind: 'cancelled', why: 'the automatic restart is off (refresh.autoRestart in the team config)' }, name));
    return EXIT.ok;
  }
  const result = await runRestart(
    {
      store,
      files: runtime.files,
      processes: runtime.sessionProcesses,
      clock: runtime.clock,
      sleep: runtime.sleep,
      platform: runtime.platform,
      asks: new ClearAsks(runtime.files, clearAskDir(kit.paths.kitHome)),
      restore: new RestoreRegistry(runtime.files, restoreSessionsDir(kit.paths.kitHome)),
      openTab: async () => {
        const tab = { team, id, name, project, prompt: refreshPrompt(team, id, store.handoverPath(id)), terminal: config.open.terminal };
        const { outcome } = await openSessionTab(runtime, tab);
        return outcome.kind === 'opened' ? { kind: 'opened' } : outcome;
      },
    },
    { team, id, at, delayMs: config.refresh.restartDelaySeconds * 1000, endCommand: config.refresh.endCommand, fallbackCwd: project },
  );
  const line = inboxLineOf(result);
  if (line !== undefined) {
    const secrets = new SecretScanner(config.register.secretPatterns);
    const problem = await postLine(inboxDepsOf(runtime, kit.paths).inboxes, secrets, { to: id, from: KIT_NAME, text: line, now: new Date(runtime.clock.now()) });
    if (problem !== undefined) {
      runtime.out.stderr(`WARN the inbox line to ${name} was not written: ${problem}`);
    }
  }
  runtime.out.stdout(resultLineOf(result, name));
  return result.kind === 'failed' ? EXIT.failed : EXIT.ok;
}
