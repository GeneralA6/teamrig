import { DEFAULT_PACKAGE_GUARD } from '../config/defaults.ts';
import type { ConfigLoad } from '../config/load.ts';
import type { AdHocRunners, HookAsks } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import { isRecord, recordField, stringField } from '../core/guards.ts';
import { adHocCallsOf } from '../package-guard/ad-hoc.ts';
import { lostFlagsOf, type LostFlag } from '../package-guard/lost-flags.ts';
import type { ProgramsContext } from '../package-guard/programs.ts';
import { holdBackOutput } from './permission.ts';

export interface PackageGuardEnv {
  /** The folder to judge from when the payload names none. */
  readonly cwd: string;
  readonly home: string;
  /** Where the guard looks for each bin a runner would run (`node_modules/.bin`). */
  readonly files: Files;
  readonly adHocRunners: AdHocRunners;
  /** Whether a run the guard would ask about raises the prompt or is refused with what to do instead. */
  readonly hookAsks: HookAsks;
}

/** What an ad-hoc package run gets. A missing or unreadable config keeps the default, so a broken config never switches the guard off. */
export function adHocRunnersOf(load: ConfigLoad | undefined): AdHocRunners {
  return load?.status === 'loaded' ? load.config.packageGuard.adHocRunners : DEFAULT_PACKAGE_GUARD.adHocRunners;
}

/** Why the calls are refused or asked about, with the vetted route to the same tool. */
export function adHocReason(calls: readonly string[]): string {
  const named = calls.map((call) => `\`${call}\``).join(', ');
  const verb = calls.length === 1 ? 'fetches and runs a package' : 'fetch and run packages';
  return (
    `teamrig package guard: ${named} ${verb} outside the project's lockfile, unvetted. Vet the exact version first ` +
    '(publish date, advisories), add it as a pinned devDependency, then run its local bin (npx --no -- <bin>). [packageGuard.adHocRunners]'
  );
}

/** Why the npx calls are refused: each hands its bin's flag to npm, with the form that keeps it for the bin. */
export function lostFlagReason(lost: readonly LostFlag[]): string {
  const named = lost.map(({ bin, flag }) => `\`npx --no ${bin} ${flag}\` runs npm with ${flag}, not ${bin} (run \`npx --no -- ${bin} ${flag}\`)`);
  return `teamrig package guard: ${named.join('; ')}. npx takes the word after a bare --no as that option's value, so the flags after it go to npm; put -- after --no.`;
}

/** What the guard decides on a line. */
interface Verdict {
  readonly decision: Exclude<AdHocRunners, 'allow'>;
  readonly reason: string;
}

/** The ad-hoc runs in a line, refused or asked about as the team set, or undefined for none. */
async function adHocVerdict(command: string, context: ProgramsContext, files: Files, decision: Verdict['decision']): Promise<Verdict | undefined> {
  const calls = await adHocCallsOf(command, context, files);
  return calls.length === 0 ? undefined : { decision, reason: adHocReason(calls) };
}

/**
 * The PreToolUse output for a Bash or PowerShell call: a refusal (or a question, as `packageGuard.adHocRunners`
 * says) when the line runs a package ad hoc, and a refusal whatever that key says when an npx call hands its bin's
 * flag to npm, as that line cannot run what it names; else nothing, so the normal permission flow decides. Under
 * `hookAsks: refuse` the question is a refusal instead, its reason saying what to do (see `holdBack`).
 */
export async function packageGuardOutput(payload: unknown, env: PackageGuardEnv): Promise<string> {
  if (!isRecord(payload)) {
    return '';
  }
  const command = stringField(recordField(payload, 'tool_input') ?? {}, 'command');
  if (command === undefined) {
    return '';
  }
  const context: ProgramsContext = {
    cwd: stringField(payload, 'cwd') ?? env.cwd,
    home: env.home,
    dialect: stringField(payload, 'tool_name') === 'PowerShell' ? 'powershell' : 'bash',
  };
  const adHoc = env.adHocRunners === 'allow' ? undefined : await adHocVerdict(command, context, env.files, env.adHocRunners);
  const lost = lostFlagsOf(command, context);
  const verdict: Verdict | undefined =
    lost.length === 0 ? adHoc : { decision: 'deny', reason: [lostFlagReason(lost), ...(adHoc === undefined ? [] : [adHoc.reason])].join(' ') };
  if (verdict === undefined) {
    return '';
  }
  return holdBackOutput(verdict.decision, verdict.reason, env.hookAsks);
}
