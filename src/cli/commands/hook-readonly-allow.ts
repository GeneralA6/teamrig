import type { KitConfig } from '../../config/types.ts';
import { readonlyRulesOf, readonlyShellReply, type PrintsSecret } from '../../hooks/readonly-shell.ts';
import type { ReadonlyRules } from '../../readonly-shell/rules.ts';
import { secretFindingsOf } from '../../hooks/secret-guard.ts';
import type { HookEvent, HookReply } from '../../ports/host/index.ts';
import { newestSnapshotExports, UNREAD_SNAPSHOT } from '../../readonly-shell/snapshot.ts';
import { secretRulesOf } from '../../secret-guard/rules.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { pathsIfKnown, secretFilesOf } from '../host.ts';
import { openKit } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { readHookInput, sessionTeam, writeReply } from './hook-input.ts';

/** The read-only check a hook runs on a call: the team's read-only rules and its secret guard. */
export interface ReadonlyCheck {
  readonly rules: ReadonlyRules;
  readonly printsSecret: PrintsSecret;
}

/** The team's read-only check, built whether `readonlyShell.enabled` is on or not: each hook decides when it applies. */
export async function readonlyCheckOf(runtime: CliRuntime, config: KitConfig): Promise<ReadonlyCheck> {
  const snapshots = pathsIfKnown(runtime)?.shellSnapshots(runtime.userHome);
  const snapshot = snapshots === undefined ? UNREAD_SNAPSHOT : await newestSnapshotExports(runtime.files, snapshots);
  const secrets = secretRulesOf(config.secretGuard, runtime.userHome, runtime.platform, secretFilesOf(runtime), config.register.secretPatterns);
  return {
    rules: readonlyRulesOf(config.readonlyShell, runtime.env, snapshot),
    printsSecret: (event) => secretFindingsOf(event, runtime.cwd, secrets).length > 0,
  };
}

/**
 * The hook's reply to this call: an allow for a line that only reads when the session's team turned the hook on, else
 * none. It reads the session's team, not the one of the folder the line `cd`s into, so a line never gains another
 * team's trusted prefixes.
 */
async function readonlyAllowReplyOf(runtime: CliRuntime, event: HookEvent): Promise<HookReply | undefined> {
  const found = await sessionTeam(event.cwd, runtime);
  const kit = found.kind === 'team' ? await openKit(runtime, found.team) : undefined;
  if (kit?.load.status !== 'loaded' || !kit.load.config.readonlyShell.enabled) {
    return undefined;
  }
  const check = await readonlyCheckOf(runtime, kit.load.config);
  return readonlyShellReply(event, check.rules, check.printsSecret);
}

/**
 * PreToolUse on Bash and PowerShell: with `readonlyShell.enabled`, lets a line whose every command provably only
 * reads (hooks/readonly-shell.ts) run without a permission prompt. Outside a team, with the hook off, for a line it
 * cannot prove reads or one that prints a secret (hooks/secret-guard.ts), for input that is not a hook payload or on any error, it prints nothing, so Claude Code's own
 * permission check decides: it fails closed.
 */
export async function readonlyAllow(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const { event } = await readHookInput(runtime);
  const reply = event === undefined ? undefined : await readonlyAllowReplyOf(runtime, event).catch(() => undefined);
  writeReply(runtime, 'tool-start', reply);
  return EXIT.ok;
}
