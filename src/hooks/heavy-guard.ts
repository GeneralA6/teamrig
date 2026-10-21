import { DEFAULT_HEAVY } from '../config/defaults.ts';
import type { ConfigLoad } from '../config/load.ts';
import type { HookAsks, UnwrappedHeavySteps } from '../config/types.ts';
import { isRecord, recordField, stringField } from '../core/guards.ts';
import { heavyStepOf, type HeavyStep } from '../package-guard/heavy-steps.ts';
import { programsOf, type ProgramRun, type ProgramsContext } from '../package-guard/programs.ts';
import { absoluteDir } from '../push-guard/location.ts';
import type { ShellWord } from '../push-guard/tokenizer.ts';
import { posixWord } from '../test-run/shell.ts';
import { holdBackOutput } from './permission.ts';

/**
 * The heavy guard: a test suite or a build a Bash or PowerShell call runs outside `teamrig heavy` and `teamrig test`
 * runs outside the host lock, so parallel sessions starve the host. The guard refuses it and hands back the
 * `teamrig heavy` call that runs the same words, the way the budget counts it as a miss (`missHeavyOutside`).
 */

/** A `--what` label longer than this is cut, so the ledger line stays short. */
const LABEL_MAX_LENGTH = 40;
/** The placeholder a suggested call names as its session when the guard cannot tell whose tab it is. */
export const UNKNOWN_SESSION = '<you>';

export interface HeavyGuardEnv {
  /** The folder to judge from when the payload names none. */
  readonly cwd: string;
  readonly home: string;
  readonly unwrapped: UnwrappedHeavySteps;
  /** Passed on with the refusal, which stays a refusal under either setting. */
  readonly hookAsks: HookAsks;
  /** This tab's team session, read only when the guard refuses; undefined when the tab is bound to none. */
  readonly session: () => Promise<string | undefined>;
}

/** A refused step and the heavy step it is. */
export interface UnwrappedStep {
  readonly run: ProgramRun;
  readonly step: HeavyStep;
}

/** What an unwrapped heavy step gets. A missing or unreadable config keeps the default, so a broken config never switches the guard off. */
export function unwrappedOf(load: ConfigLoad | undefined): UnwrappedHeavySteps {
  return load?.status === 'loaded' ? load.config.coordinator.heavy.unwrapped : DEFAULT_HEAVY.unwrapped;
}

/** A word as a POSIX shell line keeps it: a word only known when it runs stays as written, inside double quotes. */
function shellWord(word: ShellWord): string {
  return word.dynamic ? `"${word.text.replaceAll('"', '\\"')}"` : posixWord(word.text);
}

function labelOf(words: readonly string[]): string {
  const label = words.join(' ');
  return label.length <= LABEL_MAX_LENGTH ? label : `${label.slice(0, LABEL_MAX_LENGTH - 3)}...`;
}

/**
 * The `teamrig heavy` call that runs the step under the host lock; a test also runs inside `teamrig test`. `session`
 * undefined names the `<you>` placeholder.
 */
export function wrappedCall({ run, step }: UnwrappedStep, session: string | undefined): string {
  const who = session === undefined ? UNKNOWN_SESSION : posixWord(session);
  const words = [run.name, ...run.args.map(shellWord)].join(' ');
  const heavy = `teamrig heavy --session ${who} --what ${posixWord(labelOf([run.name, ...run.args.map((word) => word.text)]))} --`;
  return step === 'test' ? `${heavy} teamrig test --session ${who} -- ${words}` : `${heavy} ${words}`;
}

/** Why the line is refused: each heavy step with the call that runs it, and where it runs when that is not the line's own folder. */
export function heavyReason(steps: readonly UnwrappedStep[], session: string | undefined, context: ProgramsContext): string {
  const start = context.cwd === undefined ? undefined : absoluteDir(context.cwd);
  const calls = steps.map((unwrapped) => {
    const { dir } = unwrapped.run;
    const from = dir !== undefined && dir !== start ? ` (from ${dir})` : '';
    return `\`${wrappedCall(unwrapped, session)}\`${from}`;
  });
  const shell = context.dialect === 'powershell' ? ' The call is written for a POSIX shell: run it in the Bash tool.' : '';
  return (
    `teamrig heavy guard: this line runs a test or a build outside the host lock, which keeps parallel sessions from ` +
    `starving the host. Run it as ${calls.join(', then ')}, in the background.${shell} A pipe or a redirect such as ` +
    '`| tail` may stay outside the teamrig heavy call; a line of several commands can also go as one quoted word after --, ' +
    'which runs as written. [coordinator.heavy.unwrapped]'
  );
}

/**
 * The PreToolUse output for a Bash or PowerShell call: a refusal, naming the `teamrig heavy` call to run instead, when
 * the line runs a test suite or a build that neither `teamrig heavy` nor `teamrig test` starts; else nothing, so the
 * normal permission flow decides. A refusal stays a refusal under `hookAsks: refuse`.
 */
export async function heavyGuardOutput(payload: unknown, env: HeavyGuardEnv): Promise<string> {
  if (env.unwrapped === 'allow' || !isRecord(payload)) {
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
  const steps = programsOf(command, context).flatMap((run): UnwrappedStep[] => {
    const step = run.runner ? undefined : heavyStepOf(run);
    return step === undefined ? [] : [{ run, step }];
  });
  if (steps.length === 0) {
    return '';
  }
  return holdBackOutput('deny', heavyReason(steps, await env.session(), context), env.hookAsks);
}
