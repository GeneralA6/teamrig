import * as nodePath from 'node:path';
import { KIT_NAME } from '../core/home.ts';
import type { HookEvent } from '../ports/host/index.ts';
import { bashDrivePath, resolveDir } from '../push-guard/location.ts';
import { isStaticWord, parseShell, type ShellCommand } from '../push-guard/tokenizer.ts';
import { rerunOf } from './rerun-forms.ts';

/**
 * The cd-compound refusal, part of the picker guard (T2730): Claude Code asks a person before a Bash line with a `cd`
 * that then runs git, or moves outside the session's folder, in auto mode too, and that prompt holds the session
 * until someone answers; overnight a p0 waited 9 hours on one, and the lead's tab 14 hours (T1749). teamrig's rerun
 * forms (hooks/rerun-forms.ts) give a line that leads with `cd D &&` a form that runs the same commands in the same
 * folder with no `cd`, so the guard refuses the line before the prompt opens, quoting that form. A line with no form
 * (a `cd` mid-line, a folder only known when it runs, a `;` after it) is refused too, telling the session to drop the
 * `cd` (T2802): only a line that stays in the folder and runs no git is left to Claude Code. The prompt refusal
 * (hooks/prompt-refuse.ts) quotes the same form, but only once a team turns `prompts.hookAsks` to refuse.
 */

/** Why the guard refuses a Bash line: it reruns as `form`, or it has no form, so its `cd` must go. */
export type CdCompound = { readonly kind: 'rerun'; readonly form: string } | { readonly kind: 'drop-cd' };

/** A leading `NAME=value` word, which sets a variable for the command instead of naming its program. */
const ASSIGNMENT = /^[A-Za-z_]\w*=/;

/** The folder the session's Bash line starts in and the home folder, which `~` and Git Bash drive paths resolve by. */
export interface SessionPlace {
  readonly cwd: string;
  readonly home: string;
  /** The path rules of a folder that names no drive: the host's own unless a test names another. */
  readonly host?: nodePath.PlatformPath;
}

/** Whether the guard looks at this event: the switch is on and it is a bash call about to run. */
export function guardsCdCompound(enabled: boolean, event: HookEvent): boolean {
  const { call } = event;
  return enabled && event.name === 'tool-start' && call?.kind === 'shell' && call.dialect === 'bash';
}

/**
 * The rerun form of a Bash `command` whose leading `cd D &&` Claude Code asks about: git runs after the move, or D lies
 * outside `place.cwd`. Undefined for any other line, and for one with no rerun form.
 */
export function cdCompoundForm(command: string, place: SessionPlace): string | undefined {
  const rerun = rerunOf('bash', command);
  if (rerun?.folder === undefined) {
    return undefined;
  }
  return rerun.programs.includes('git') || leaves(rerun.folder, place) ? rerun.form : undefined;
}

/**
 * What the guard holds against a Bash `command` Claude Code asks about: its rerun form when {@link cdCompoundForm}
 * gives one, else `drop-cd` for a line of two or more commands with a `cd` after which git runs or that may leave
 * `place.cwd`. Undefined for any other line: no `cd`, a `cd` alone, or one that stays in the folder and runs no git.
 */
export function cdCompoundOf(command: string, place: SessionPlace): CdCompound | undefined {
  const form = cdCompoundForm(command, place);
  if (form !== undefined) {
    return { kind: 'rerun', form };
  }
  const commands = parseShell(command, 'bash').commands;
  const first = commands.findIndex(isCd);
  if (first === -1 || commands.length < 2) {
    return undefined;
  }
  const after = commands.slice(first);
  return after.some((each) => programOf(each) === 'git') || movesOut(after, place) ? { kind: 'drop-cd' } : undefined;
}

/** What the guard holds against the line of a hook event's shell call, as {@link cdCompoundOf} gives it. */
export function cdCompoundOfEvent(event: HookEvent, place: SessionPlace): CdCompound | undefined {
  const { call } = event;
  return call?.kind !== 'shell' || call.command === undefined ? undefined : cdCompoundOf(call.command, place);
}

/** Why the line is refused: the rerun form to run instead, or the ways to run it with no `cd`. */
export function cdCompoundReason(compound: CdCompound): string {
  const why =
    `${KIT_NAME} picker guard: Claude Code asks a person before a \`cd\` compound that runs git or leaves the session's folder,` +
    ' and that prompt holds this session until someone answers. Do not retry this line;';
  if (compound.kind === 'rerun') {
    return `${why} rerun it as: ${compound.form}`;
  }
  return (
    `${why} a folder only known when it runs counts as leaving. Drop the \`cd\`: run git as \`git -C <dir> ...\`,` +
    ' anything else as `env -C <dir> <command>`, or name files by absolute path.'
  );
}

/** A command that runs `cd`. */
function isCd(command: ShellCommand): boolean {
  return programOf(command) === 'cd';
}

/** The program a command runs, past its leading `NAME=value` words; undefined for one that is only those. */
function programOf(command: ShellCommand): string | undefined {
  return command.words.find((word) => !ASSIGNMENT.test(word.text))?.text;
}

/**
 * True when a `cd` of `commands` may move outside the session's folder: its folder is only known when it runs (a
 * variable, `~`, `-`, an option, none at all), or it resolves outside from where the cds before it left the line. A
 * `cd` inside a subshell moves no command after it, so the walk goes on from where the line was.
 */
function movesOut(commands: readonly ShellCommand[], place: SessionPlace): boolean {
  const cwd = sessionFolder(place);
  let at = cwd;
  for (const command of commands.filter(isCd)) {
    const folder = cdFolder(command);
    const target = folder === undefined ? undefined : resolveFrom(at, folder, place);
    if (outside(cwd, target, place)) {
      return true;
    }
    if (command.subshells.length === 0) {
      at = target;
    }
  }
  return false;
}

/** The folder a `cd` names when its one word is static text, not an option or `-`; else undefined. */
function cdFolder(command: ShellCommand): string | undefined {
  const [, folder, ...more] = command.words;
  return folder !== undefined && more.length === 0 && isStaticWord(folder) && !folder.text.startsWith('-') ? folder.text : undefined;
}

/** True when `folder`, resolved from the session's folder, is not that folder or one inside it. */
function leaves(folder: string, place: SessionPlace): boolean {
  const cwd = sessionFolder(place);
  return outside(cwd, resolveFrom(cwd, folder, place), place);
}

/** The session's folder, resolved, with a Git Bash drive path read as its drive. */
function sessionFolder(place: SessionPlace): string | undefined {
  return resolveFrom(undefined, place.cwd, place);
}

/** Where `folder` leads from `from`, a Git Bash drive path read as its drive. */
function resolveFrom(from: string | undefined, folder: string, place: SessionPlace): string | undefined {
  return resolveDir(from, bashDrivePath(folder, place.home), place.home, place.host ?? nodePath);
}

/** True when `target` is not `cwd` or a folder inside it, or either is unknown. */
function outside(cwd: string | undefined, target: string | undefined, place: SessionPlace): boolean {
  if (cwd === undefined || target === undefined) {
    return true;
  }
  const rules = [cwd, target].some((path) => /^[A-Za-z]:/.test(path)) ? nodePath.win32 : (place.host ?? nodePath);
  const relative = rules.relative(cwd, target);
  return relative === '..' || relative.startsWith(`..${rules.sep}`) || rules.isAbsolute(relative);
}
