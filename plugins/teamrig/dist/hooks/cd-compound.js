import * as nodePath from 'node:path';
import { recordField, stringField } from "../core/guards.js";
import { KIT_NAME } from "../core/home.js";
import { bashDrivePath, resolveDir } from "../push-guard/location.js";
import { isStaticWord, parseShell } from "../push-guard/tokenizer.js";
import { rerunOf } from "./rerun-forms.js";
/** A leading `NAME=value` word, which sets a variable for the command instead of naming its program. */
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
/** Whether the guard looks at this payload: the switch is on and it is a PreToolUse call of Bash. */
export function guardsCdCompound(enabled, payload) {
    return enabled && stringField(payload, 'hook_event_name') === 'PreToolUse' && stringField(payload, 'tool_name') === 'Bash';
}
/**
 * The rerun form of a Bash `command` whose leading `cd D &&` Claude Code asks about: git runs after the move, or D lies
 * outside `place.cwd`. Undefined for any other line, and for one with no rerun form.
 */
export function cdCompoundForm(command, place) {
    const rerun = rerunOf('Bash', command);
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
export function cdCompoundOf(command, place) {
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
/** What the guard holds against the Bash command of a hook `payload`, as {@link cdCompoundOf} gives it. */
export function cdCompoundOfPayload(payload, place) {
    const command = stringField(recordField(payload, 'tool_input') ?? {}, 'command');
    return command === undefined ? undefined : cdCompoundOf(command, place);
}
/** Why the line is refused: the rerun form to run instead, or the ways to run it with no `cd`. */
export function cdCompoundReason(compound) {
    const why = `${KIT_NAME} picker guard: Claude Code asks a person before a \`cd\` compound that runs git or leaves the session's folder,` +
        ' and that prompt holds this session until someone answers. Do not retry this line;';
    if (compound.kind === 'rerun') {
        return `${why} rerun it as: ${compound.form}`;
    }
    return (`${why} a folder only known when it runs counts as leaving. Drop the \`cd\`: run git as \`git -C <dir> ...\`,` +
        ' anything else as `env -C <dir> <command>`, or name files by absolute path.');
}
/** A command that runs `cd`. */
function isCd(command) {
    return programOf(command) === 'cd';
}
/** The program a command runs, past its leading `NAME=value` words; undefined for one that is only those. */
function programOf(command) {
    return command.words.find((word) => !ASSIGNMENT.test(word.text))?.text;
}
/**
 * True when a `cd` of `commands` may move outside the session's folder: its folder is only known when it runs (a
 * variable, `~`, `-`, an option, none at all), or it resolves outside from where the cds before it left the line. A
 * `cd` inside a subshell moves no command after it, so the walk goes on from where the line was.
 */
function movesOut(commands, place) {
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
function cdFolder(command) {
    const [, folder, ...more] = command.words;
    return folder !== undefined && more.length === 0 && isStaticWord(folder) && !folder.text.startsWith('-') ? folder.text : undefined;
}
/** True when `folder`, resolved from the session's folder, is not that folder or one inside it. */
function leaves(folder, place) {
    const cwd = sessionFolder(place);
    return outside(cwd, resolveFrom(cwd, folder, place), place);
}
/** The session's folder, resolved, with a Git Bash drive path read as its drive. */
function sessionFolder(place) {
    return resolveFrom(undefined, place.cwd, place);
}
/** Where `folder` leads from `from`, a Git Bash drive path read as its drive. */
function resolveFrom(from, folder, place) {
    return resolveDir(from, bashDrivePath(folder, place.home), place.home, place.host ?? nodePath);
}
/** True when `target` is not `cwd` or a folder inside it, or either is unknown. */
function outside(cwd, target, place) {
    if (cwd === undefined || target === undefined) {
        return true;
    }
    const rules = [cwd, target].some((path) => /^[A-Za-z]:/.test(path)) ? nodePath.win32 : (place.host ?? nodePath);
    const relative = rules.relative(cwd, target);
    return relative === '..' || relative.startsWith(`..${rules.sep}`) || rules.isAbsolute(relative);
}
