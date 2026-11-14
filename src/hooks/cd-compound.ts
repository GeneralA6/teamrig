import * as nodePath from 'node:path';
import { recordField, stringField, type JsonRecord } from '../core/guards.ts';
import { KIT_NAME } from '../core/home.ts';
import { resolveDir } from '../push-guard/location.ts';
import { bashDrivePath } from '../secret-guard/paths.ts';
import { rerunOf } from './rerun-forms.ts';

/**
 * The cd-compound refusal, part of the picker guard (T2730): Claude Code asks a person before a Bash line that leads
 * with `cd D &&` and then runs git, or moves outside the session's folder, in auto mode too, and that prompt holds the
 * session until someone answers; overnight a p0 waited 9 hours on one. teamrig's rerun forms (hooks/rerun-forms.ts)
 * give such a line a form that runs the same commands in the same folder with no `cd`, so the guard refuses the line
 * before the prompt opens, quoting that form. A line with no rerun form, which may do something the form would not,
 * is left to Claude Code. The prompt refusal (hooks/prompt-refuse.ts) quotes the same form, but only once a team
 * turns `prompts.hookAsks` to refuse.
 */

/** The folder the session's Bash line starts in and the home folder, which `~` and Git Bash drive paths resolve by. */
export interface SessionPlace {
  readonly cwd: string;
  readonly home: string;
  /** The path rules of a folder that names no drive: the host's own unless a test names another. */
  readonly host?: nodePath.PlatformPath;
}

/** Whether the guard looks at this payload: the switch is on and it is a PreToolUse call of Bash. */
export function guardsCdCompound(enabled: boolean, payload: JsonRecord): boolean {
  return enabled && stringField(payload, 'hook_event_name') === 'PreToolUse' && stringField(payload, 'tool_name') === 'Bash';
}

/**
 * The rerun form of a Bash `command` whose leading `cd D &&` Claude Code asks about: git runs after the move, or D lies
 * outside `place.cwd`. Undefined for any other line, and for one with no rerun form.
 */
export function cdCompoundForm(command: string, place: SessionPlace): string | undefined {
  const rerun = rerunOf('Bash', command);
  if (rerun?.folder === undefined) {
    return undefined;
  }
  return rerun.programs.includes('git') || leaves(rerun.folder, place) ? rerun.form : undefined;
}

/** The rerun form for the Bash command of a hook `payload`, as {@link cdCompoundForm} gives it. */
export function cdCompoundFormOf(payload: JsonRecord, place: SessionPlace): string | undefined {
  const command = stringField(recordField(payload, 'tool_input') ?? {}, 'command');
  return command === undefined ? undefined : cdCompoundForm(command, place);
}

/** Why the line is refused, quoting the `form` to run instead. */
export function cdCompoundReason(form: string): string {
  return (
    `${KIT_NAME} picker guard: Claude Code asks a person before a \`cd\` compound that runs git or leaves the session's folder,` +
    ` and that prompt holds this session until someone answers. Do not retry this line; rerun it as: ${form}`
  );
}

/** True when `folder`, resolved from the session's folder, is not that folder or one inside it. */
function leaves(folder: string, place: SessionPlace): boolean {
  const host = place.host ?? nodePath;
  const cwd = resolveDir(undefined, bashDrivePath(place.cwd, place.home), place.home, host);
  const target = resolveDir(cwd, bashDrivePath(folder, place.home), place.home, host);
  if (cwd === undefined || target === undefined) {
    return true;
  }
  const rules = [cwd, target].some((path) => /^[A-Za-z]:/.test(path)) ? nodePath.win32 : host;
  const relative = rules.relative(cwd, target);
  return relative === '..' || relative.startsWith(`..${rules.sep}`) || rules.isAbsolute(relative);
}
