import { DEFAULT_PACKAGE_GUARD } from '../config/defaults.ts';
import type { ConfigLoad } from '../config/load.ts';
import type { AdHocRunners, HookAsks, PackageGuardConfig, PackageInstalls } from '../config/types.ts';
import { toolCommandReadings } from '../core/bash-tool-readings.ts';
import type { Files } from '../core/files.ts';
import { isRecord, recordField, stringField } from '../core/guards.ts';
import type { Clock } from '../core/lock.ts';
import { uniqueBy } from '../core/unique-by.ts';
import { adHocCallsOf } from '../package-guard/ad-hoc.ts';
import { installCallsOf, type InstallTarget } from '../package-guard/installs.ts';
import { linkedModulesWritesOf, type LinkedModulesWrite, type LinkReader } from '../package-guard/linked-modules.ts';
import { lostFlagsOf, type LostFlag } from '../package-guard/lost-flags.ts';
import type { ProgramsContext } from '../package-guard/programs.ts';
import type { PackageRegistry } from '../package-guard/registry.ts';
import { unvettedOf } from '../package-guard/vet.ts';
import { holdBackOutput } from './permission.ts';

/**
 * How long the guard waits for the registry, every request together. The hook runs under a 15 s limit and lets the
 * call through when it passes, so the guard gives up first and refuses what the registry did not vouch for.
 */
export const INSTALL_VET_TIMEOUT_MS = 10_000;

export interface PackageGuardEnv extends PackageGuardConfig {
  /** The folder to judge from when the payload names none. */
  readonly cwd: string;
  readonly home: string;
  /** Where the guard looks for each bin a runner would run (`node_modules/.bin`). */
  readonly files: Files;
  /** Where the guard tells a node_modules link (a symlink or a junction) from a real folder, and where it points. */
  readonly tree: LinkReader;
  /** Where the guard reads each version an install names: its publish time and advisories. */
  readonly registry: PackageRegistry;
  readonly clock: Clock;
  /** Whether a run the guard would ask about raises the prompt or is refused with what to do instead. */
  readonly hookAsks: HookAsks;
  /** The host's platform: on Windows a Bash line is judged as written and as bash receives it (core/bash-tool-readings.ts). */
  readonly platform: NodeJS.Platform;
}

/** What ad-hoc runs and unvetted installs get. A missing or unreadable config keeps the default, so a broken config never switches the guard off. */
export function packageGuardOf(load: ConfigLoad | undefined): PackageGuardConfig {
  return load?.status === 'loaded' ? load.config.packageGuard : DEFAULT_PACKAGE_GUARD;
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

/** Why the npx calls are refused: each hands its bin's flag to npm, with the form that keeps it. */
export function lostFlagReason(lost: readonly LostFlag[]): string {
  const named = lost.map(({ bin, flag }) => `\`npx --no ${bin} ${flag}\` runs npm with ${flag}, not ${bin} (run \`npx --no -- ${bin} ${flag}\`)`);
  return `teamrig package guard: ${named.join('; ')}. npx takes the word after a bare --no as that option's value, so the flags after it go to npm; put -- after --no.`;
}

/** Why an install is refused or asked about: each package the registry did not vouch for, and what it takes to be vetted. */
export function installReason(unvetted: readonly string[], cooldownDays: number): string {
  const age = cooldownDays === 0 ? '' : ` published at least ${cooldownDays} day${cooldownDays === 1 ? '' : 's'} ago`;
  return (
    `teamrig package guard: this install is not vetted: ${unvetted.join('; ')}. Install an exact version${age} with no known advisory ` +
    '(`npm view <name> time` lists when each version was published). [packageGuard.installs]'
  );
}

/** Why a call is refused: each node_modules link it would write through, and the two safe ways to install. */
export function linkedModulesReason(writes: readonly LinkedModulesWrite[]): string {
  const named = writes.map(({ call, modules, target }) => `\`${call}\` would write through ${modules}, a link to ${target}`);
  return (
    `teamrig package guard: ${named.join('; ')}. A package manager rewrites the folder a link points to (npm ci empties it first), ` +
    'breaking every checkout that shares it. Remove the link itself first (Bash `rm <link>` or `cmd /c rmdir <link>`; a recursive delete ' +
    'empties its target too), then install a copy here; or install in the checkout that owns the folder.'
  );
}

/** What the guard decides on a line. */
interface Verdict {
  readonly decision: Exclude<AdHocRunners | PackageInstalls, 'allow'>;
  readonly reason: string;
}

/** Every field of an install target, so one a line's readings both name is vetted once. */
function targetKey(target: InstallTarget): string {
  if (target.kind === 'unvetted') {
    return JSON.stringify([target.kind, target.spec, target.why]);
  }
  const wanted = target.wanted.kind === 'version' ? target.wanted.version : target.wanted.tag;
  return JSON.stringify([target.kind, target.spec, target.name, target.wanted.kind, wanted]);
}

/** The ad-hoc runs in a line's readings, each once, refused or asked about as the team set, or undefined for none. */
async function adHocVerdict(readings: readonly string[], context: ProgramsContext, env: PackageGuardEnv): Promise<Verdict | undefined> {
  if (env.adHocRunners === 'allow') {
    return undefined;
  }
  const each = await Promise.all(readings.map((text) => adHocCallsOf(text, context, env.files)));
  const calls = [...new Set(each.flat())];
  return calls.length === 0 ? undefined : { decision: env.adHocRunners, reason: adHocReason(calls) };
}

/**
 * The packages a line's readings install that the registry does not vouch for, refused or asked about as the team
 * set, or undefined for none. Each target is vetted once, so the registry is read once per package.
 */
async function installVerdict(readings: readonly string[], context: ProgramsContext, env: PackageGuardEnv): Promise<Verdict | undefined> {
  if (env.installs === 'allow') {
    return undefined;
  }
  const targets = uniqueBy(
    readings.flatMap((text) => installCallsOf(text, context).flatMap((call) => call.targets)),
    targetKey,
  );
  if (targets.length === 0) {
    return undefined;
  }
  const unvetted = await unvettedOf(targets, env, { cooldownDays: env.cooldownDays, timeoutMs: INSTALL_VET_TIMEOUT_MS });
  return unvetted.length === 0 ? undefined : { decision: env.installs, reason: installReason(unvetted, env.cooldownDays) };
}

/** The npx calls in a line's readings that hand their bin's flag to npm, each once: refused whatever the config says, as the line cannot run what it names. */
function lostFlagVerdict(readings: readonly string[], context: ProgramsContext): Verdict | undefined {
  const lost = uniqueBy(
    readings.flatMap((text) => lostFlagsOf(text, context)),
    ({ bin, flag }) => `${bin} ${flag}`,
  );
  return lost.length === 0 ? undefined : { decision: 'deny', reason: lostFlagReason(lost) };
}

/** The calls in a line's readings that would write through a node_modules link, each once: refused whatever the config says, as no answer makes them safe. */
async function linkedModulesVerdict(readings: readonly string[], context: ProgramsContext, tree: LinkReader): Promise<Verdict | undefined> {
  const each = await Promise.all(readings.map((text) => linkedModulesWritesOf(text, context, tree)));
  const writes = uniqueBy(each.flat(), ({ call, modules }) => JSON.stringify([call, modules]));
  return writes.length === 0 ? undefined : { decision: 'deny', reason: linkedModulesReason(writes) };
}

/**
 * The PreToolUse output for a Bash or PowerShell call: a refusal (or a question, as `packageGuard.adHocRunners` and
 * `packageGuard.installs` say) when the line runs a package ad hoc or installs a version the registry does not vouch
 * for, and a refusal whatever the config says when an npx call hands its bin's flag to npm or a package manager would
 * rewrite node_modules through a link; else nothing, so the normal permission flow decides. One refusal among them
 * refuses the line, naming every reason. Under `hookAsks: refuse` the question is a refusal instead, its reason saying
 * what to do (see `holdBack`). A Bash line on Windows is judged in each reading bash may run (`toolCommandReadings`),
 * naming each call once.
 */
export async function packageGuardOutput(payload: unknown, env: PackageGuardEnv): Promise<string> {
  if (!isRecord(payload)) {
    return '';
  }
  const command = stringField(recordField(payload, 'tool_input') ?? {}, 'command');
  if (command === undefined) {
    return '';
  }
  const tool = stringField(payload, 'tool_name');
  const context: ProgramsContext = {
    cwd: stringField(payload, 'cwd') ?? env.cwd,
    home: env.home,
    dialect: tool === 'PowerShell' ? 'powershell' : 'bash',
  };
  const readings = toolCommandReadings(tool, command, env.platform);
  const [adHoc, install, linked] = await Promise.all([
    adHocVerdict(readings, context, env),
    installVerdict(readings, context, env),
    linkedModulesVerdict(readings, context, env.tree),
  ]);
  const verdicts = [lostFlagVerdict(readings, context), linked, adHoc, install].filter((verdict) => verdict !== undefined);
  if (verdicts.length === 0) {
    return '';
  }
  const decision = verdicts.some((verdict) => verdict.decision === 'deny') ? 'deny' : 'ask';
  return holdBackOutput(decision, verdicts.map((verdict) => verdict.reason).join(' '), env.hookAsks);
}
