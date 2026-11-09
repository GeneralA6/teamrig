import { join } from 'node:path';
import type { KitConfig } from '../../config/types.ts';
import { isRecord, type JsonRecord } from '../../core/guards.ts';
import { claudeConfigDir } from '../../core/home.ts';
import { readonlyRulesOf, readonlyShellOutput, type PrintsSecret } from '../../hooks/readonly-shell.ts';
import type { ReadonlyRules } from '../../readonly-shell/rules.ts';
import { secretFindingsOf } from '../../hooks/secret-guard.ts';
import { newestSnapshotExports } from '../../readonly-shell/snapshot.ts';
import { secretRulesOf } from '../../secret-guard/rules.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { openKit } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { parseJson, sessionTeam } from './hook-input.ts';

/** The read-only check a hook runs on a call: the team's read-only rules and its secret guard. */
export interface ReadonlyCheck {
  readonly rules: ReadonlyRules;
  readonly printsSecret: PrintsSecret;
}

/** The team's read-only check, built whether `readonlyShell.enabled` is on or not: each hook decides when it applies. */
export async function readonlyCheckOf(runtime: CliRuntime, config: KitConfig): Promise<ReadonlyCheck> {
  const snapshot = await newestSnapshotExports(runtime.files, join(claudeConfigDir(runtime.env, runtime.userHome), 'shell-snapshots'));
  const secrets = secretRulesOf(config.secretGuard, runtime.userHome, runtime.platform, config.register.secretPatterns);
  return {
    rules: readonlyRulesOf(config.readonlyShell, runtime.env, snapshot),
    printsSecret: (call) => secretFindingsOf(call, runtime.cwd, secrets).length > 0,
  };
}

/**
 * What the hook prints for this payload: an allow for a line that only reads when the session's team turned the hook
 * on, else ''. It reads the session's team, not the one of the folder the line `cd`s into, so a line never gains
 * another team's trusted prefixes.
 */
async function readonlyAllowOutputOf(runtime: CliRuntime, payload: JsonRecord): Promise<string> {
  const found = await sessionTeam(payload, runtime);
  const kit = found.kind === 'team' ? await openKit(runtime, found.team) : undefined;
  if (kit?.load.status !== 'loaded' || !kit.load.config.readonlyShell.enabled) {
    return '';
  }
  const check = await readonlyCheckOf(runtime, kit.load.config);
  return readonlyShellOutput(payload, check.rules, check.printsSecret, runtime.platform);
}

/**
 * PreToolUse on Bash and PowerShell: with `readonlyShell.enabled`, lets a line whose every command provably only
 * reads (hooks/readonly-shell.ts) run without a permission prompt. Outside a team, with the hook off, for a line it
 * cannot prove reads or one that prints a secret (hooks/secret-guard.ts), for input that is not a hook payload or on any error, it prints nothing, so Claude Code's own
 * permission check decides: it fails closed.
 */
export async function readonlyAllow(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const output = isRecord(payload) ? await readonlyAllowOutputOf(runtime, payload).catch(() => '') : '';
  if (output !== '') {
    runtime.out.stdout(output);
  }
  return EXIT.ok;
}
