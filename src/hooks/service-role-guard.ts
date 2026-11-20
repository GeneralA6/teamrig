import { posix, win32 } from 'node:path';
import { OWNER_GATED_KEYS } from '../config/owner-gated.ts';
import { toolCommandReadings } from '../core/bash-tool-readings.ts';
import { isRecord, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import type { ProgramsContext } from '../package-guard/programs.ts';
import type { ShellWord } from '../push-guard/tokenizer.ts';
import { opaqueGuardedWords, runsOfReadings, teamrigLaunchOf } from './exec-guard.ts';
import { holdBackOutput, refusalOutput } from './permission.ts';

/**
 * The service-role guard (T2984, security condition C2): a service role lets its holders run a few teamrig commands
 * past every permission check, so who holds one is a permission, an owner gate. A session's `teamrig roles grant` or
 * `revoke` therefore always asks the owner, whatever `--yes` says (refused when asks are off), and the route allow
 * never lets one through, as it allows only what every guard passed. A session's own write of an owner-gated key
 * (OWNER_GATED_KEYS: `serviceRoles`, the roles, the guards and allow rules, the commands teamrig runs; T3083)
 * is refused: a file tool whose result changes one in any team's config, or cannot be read, by any spelling that
 * reaches the file (T2984), and a shell line naming a team config file at all, since a shell line's writes cannot be
 * told from its reads (the Read tool stays open). The config's other keys stay a session's to edit. Like
 * the pass-record guard it reads only the call: a script the session writes and starts still reaches the file, as
 * sessions and the owner share one account (stopgap T791). A teamrig call whose subcommand is only known when it runs,
 * and a shell fed by a pipe, are the exec guard's to refuse.
 *
 * It holds a team's exec audit log the same way (#870): the log carries every privileged command's approval and the
 * runtime pin's, so a session's file tool writing it, by any spelling that reaches it, and a shell line naming it are
 * refused; only `teamrig exec` appends to it, and `teamrig exec status` and the Read tool read it.
 */

/** The `teamrig roles` commands that change who holds a role. */
export const ROLE_CHANGES: ReadonlySet<string> = new Set(['grant', 'revoke']);

/** The file tools, by the input field naming the file they write. */
const FILE_WRITERS: ReadonlyMap<string, string> = new Map([
  ['Write', 'file_path'],
  ['Edit', 'file_path'],
  ['MultiEdit', 'file_path'],
  ['NotebookEdit', 'notebook_path'],
]);

const SHELLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);

/**
 * A team config path in a line: `teams/<team>/config.json`, any slash, a glob or variable as the team too, its 8.3
 * short name (`CONFIG~1.JSO`) and the trailing dots Windows drops (`config.json.`) included.
 */
const TEAM_CONFIG_TAIL = /teams[\\/]+[^\s\\/'"]+[\\/]+config(?:\.json|~\d+\.jso)(?![\w-]|\.+[\w-])/i;

/** `config.json` as a file name of its own (its short name too): not `tsconfig.json`, `config.json5` or `config.json.bak`. */
const CONFIG_FILE_WORD = /(?<![\w.-])config(?:\.json|~\d+\.jso)(?![\w-]|\.+[\w-])/i;

/** A line reaching into the kit home: its folder, or the variable that moves it. */
const KIT_HOME_WORD = /(?<![\w-])\.teamrig(?![\w-])|TEAMRIG_HOME/i;

export interface ServiceRoleGuardEnv {
  /** The folder the call runs in when the payload names none. */
  readonly cwd: string;
  readonly home: string;
  readonly platform: NodeJS.Platform;
  /** The team config file, or undefined when the hook found no team config to keep; its kit home holds every team's. */
  readonly configPath: string | undefined;
  /** A team config's text now, by its absolute path, or undefined when there is none. */
  readonly readConfig: (path: string) => Promise<string | undefined>;
  /** The real path of an existing path (links and case resolved), or undefined when nothing is there. */
  readonly canonical: (path: string) => Promise<string | undefined>;
}

/** A team's exec audit log by its tail, on a path in its compare form: `teams/<team>/exec/audit.jsonl`, its 8.3 short name too. */
const EXEC_LOG_FILE = /(?:^|\/)teams\/+[^/]+\/+exec\/+audit(?:\.jsonl|~\d+\.jso)$/i;

/** The exec audit log's file name, or its 8.3 short name, as a path's last segment. */
const EXEC_LOG_NAME = /^audit(?:\.jsonl|~\d+\.jso)$/i;

/** The exec audit log in a shell line: `exec/audit.jsonl`, either slash, its short name too. */
const EXEC_LOG_WORD = /(?<![\w-])exec[\\/]+audit(?:\.jsonl|~\d+\.jso)(?![\w-]|\.+[\w-])/i;

/** `audit.jsonl` as a file name of its own, which names the log from inside a team's exec folder. */
const EXEC_LOG_BARE = /(?<![\w.-])audit(?:\.jsonl|~\d+\.jso)(?![\w-]|\.+[\w-])/i;

/** A team's exec folder, on a path in its compare form. */
const EXEC_FOLDER = /(?:^|\/)teams\/+[^/]+\/+exec$/i;

/** A team config's file name, or its 8.3 short name (`CONFIG~1.JSO`), as a path's last segment. */
const CONFIG_NAME = /^config(?:\.json|~\d+\.jso)$/i;

/** A Windows spelling that reaches a file past its plain path, which neither the text nor its real path ties to one file. */
type AliasForm = 'a device path' | 'a network share path' | 'an alternate data stream';

/** True when the words run `roles grant` or `roles revoke`, or a `roles` command only known when it runs. */
function startsRoleChange(words: readonly ShellWord[]): boolean {
  const [group, action] = words;
  return group !== undefined && !group.dynamic && group.text === 'roles' && action !== undefined && (action.dynamic || ROLE_CHANGES.has(action.text));
}

/**
 * A path as the platform compares it: absolute against the folder, one slash, any case on Windows, where each
 * segment also drops the trailing dots and spaces Windows ignores (`config.json.` opens `config.json`).
 */
function samePathKey(path: string, cwd: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') {
    return posix.resolve(cwd, path);
  }
  const segments = win32.resolve(cwd, path).replaceAll('\\', '/').toLowerCase().split('/');
  return segments.map((segment, index) => (index === 0 ? segment : segment.replace(/[. ]+$/, ''))).join('/');
}

/** A path's last segment, past a leading drive (`C:config.json` names `config.json`). */
function lastSegmentOf(path: string): string {
  const undriven = path.replace(/^[a-z]:/i, '');
  return undriven.slice(Math.max(undriven.lastIndexOf('/'), undriven.lastIndexOf('\\')) + 1);
}

/** How a Windows path reaches a file past its plain spelling, or undefined for a plain one. */
function aliasFormOf(path: string): AliasForm | undefined {
  if (/^[\\/]{2}[?.][\\/]/.test(path)) {
    return 'a device path';
  }
  if (/^[\\/]{2}[^\\/]/.test(path)) {
    return 'a network share path';
  }
  return lastSegmentOf(path).includes(':') ? 'an alternate data stream' : undefined;
}

/** The file name Windows opens for a path: its last segment with a stream cut and trailing dots and spaces dropped. */
function openedNameOf(path: string): string {
  return (lastSegmentOf(path).split(':')[0] ?? '').replace(/[. ]+$/, '');
}

/** The kit home a team config sits in: `<home>/teams/<team>/config.json`. */
function kitHomeOf(configPath: string, platform: NodeJS.Platform): string {
  const path = platform === 'win32' ? win32 : posix;
  return path.dirname(path.dirname(path.dirname(configPath)));
}

/** A Git Bash drive path's head, `/c/`, which Windows tools read as the drive `c:/`. */
const MSYS_DRIVE = /^\/([a-z])(?=\/)/i;

/**
 * A team config by its tail, `teams/<team>/config.json`, on a path in its compare form (one slash kind). Its 8.3 short
 * name (`CONFIG~1.JSO`) counts too: Windows opens the config by it, and the real path gives it back unchanged.
 */
const TEAM_CONFIG_FILE = /(?:^|\/)teams\/+[^/]+\/+config(?:\.json|~\d+\.jso)$/i;

/**
 * The absolute path of the team config a file tool's path names, or undefined for another file. Any team's config
 * counts, not only the session's own, as each team's guards read their own (T3083). It is told by the same tail the
 * shell check uses, so the kit home's spelling (a Git Bash `/c/` drive, a `\\?\` long path) cannot hide it and a
 * session with no team config of its own is still held to it; then by its real path, so a link to one is one too
 * (T2984).
 */
async function teamConfigOf(path: string, cwd: string, env: ServiceRoleGuardEnv): Promise<string | undefined> {
  const native = env.platform === 'win32' ? path.replace(MSYS_DRIVE, '$1:') : path;
  const key = samePathKey(native, cwd, env.platform);
  if (env.configPath !== undefined && key === samePathKey(env.configPath, cwd, env.platform)) {
    return env.configPath;
  }
  const absolute = (env.platform === 'win32' ? win32 : posix).resolve(cwd, native);
  if (TEAM_CONFIG_FILE.test(key)) {
    return absolute;
  }
  const real = await env.canonical(absolute);
  return real !== undefined && TEAM_CONFIG_FILE.test(samePathKey(real, cwd, env.platform)) ? real : undefined;
}

/** True when a file tool's path is a team's exec audit log: by its tail in any spelling, or by its real path, so a link to it is it too. */
async function isExecLog(path: string, cwd: string, env: ServiceRoleGuardEnv): Promise<boolean> {
  const native = env.platform === 'win32' ? path.replace(MSYS_DRIVE, '$1:') : path;
  if (EXEC_LOG_FILE.test(samePathKey(native, cwd, env.platform))) {
    return true;
  }
  const real = await env.canonical((env.platform === 'win32' ? win32 : posix).resolve(cwd, native));
  return real !== undefined && EXEC_LOG_FILE.test(samePathKey(real, cwd, env.platform));
}

/** True when a shell line names a team's exec audit log: `exec/audit.jsonl`, or `audit.jsonl` run from a team's exec folder. */
function namesExecLog(command: string, cwd: string, env: ServiceRoleGuardEnv): boolean {
  return EXEC_LOG_WORD.test(command) || (EXEC_FOLDER.test(samePathKey(cwd, env.cwd, env.platform)) && EXEC_LOG_BARE.test(command));
}

function execLogRefusalOf(reach: string): string {
  return (
    `teamrig exec log guard: ${reach}. The exec audit log is hash-chained and only teamrig exec appends to it; its ` +
    "approvals, a runtime pin's (teamrig exec node-pin) too, are the security reviewer's, so a line a session writes by " +
    'hand has none and breaks or fails the chain. Read it with teamrig exec status or the Read tool, and do not retry ' +
    'this or route around it: a log that looks wrong goes to the lead.'
  );
}

/** The config text as JSON, or undefined when there is none or it is no JSON object. */
function configOf(text: string | undefined): JsonRecord | undefined {
  if (text === undefined) {
    return undefined;
  }
  try {
    const raw: unknown = JSON.parse(text);
    return isRecord(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** A key's value as text to compare, `null` when the config or any step of the path lacks it. */
function valueAt(config: JsonRecord | undefined, keyPath: readonly string[]): string {
  let at: unknown = config;
  for (const step of keyPath) {
    at = isRecord(at) ? at[step] : undefined;
  }
  return JSON.stringify(at ?? null);
}

/** The owner-gated keys whose value differs between two config texts, dotted. */
export function changedGatedKeys(before: string | undefined, after: string): string[] {
  const [old, next] = [configOf(before), configOf(after)];
  return OWNER_GATED_KEYS.filter((keyPath) => valueAt(old, keyPath) !== valueAt(next, keyPath)).map((keyPath) => keyPath.join('.'));
}

/** One string replacement of an Edit or a MultiEdit edit. */
interface Replacement {
  readonly from: string;
  readonly to: string;
  readonly all: boolean;
}

function replacementOf(input: JsonRecord): Replacement | undefined {
  const from = stringField(input, 'old_string');
  const to = stringField(input, 'new_string');
  return from === undefined || to === undefined ? undefined : { from, to, all: input['replace_all'] === true };
}

/** The text after the replacements, or undefined when one finds nothing to replace, so the guard cannot tell the result. */
function replaced(text: string, replacements: readonly Replacement[]): string | undefined {
  let next = text;
  for (const { from, to, all } of replacements) {
    if (from === '' || !next.includes(from)) {
      return undefined;
    }
    next = all ? next.split(from).join(to) : next.replace(from, () => to);
  }
  return next;
}

/** The config's text after a file tool's call, or undefined when the guard cannot work it out. */
function nextText(tool: string, input: JsonRecord, current: string | undefined): string | undefined {
  if (tool === 'Write') {
    return stringField(input, 'content');
  }
  if (tool === 'Edit') {
    const one = replacementOf(input);
    return one === undefined || current === undefined ? undefined : replaced(current, [one]);
  }
  if (tool === 'MultiEdit') {
    const edits = input['edits'];
    if (!Array.isArray(edits) || current === undefined) {
      return undefined;
    }
    const each = edits.map((edit) => (isRecord(edit) ? replacementOf(edit) : undefined));
    return each.every((edit) => edit !== undefined) ? replaced(current, each.filter((edit) => edit !== undefined)) : undefined;
  }
  return undefined;
}

/** Why a file tool's call on the team config is refused, or undefined when it leaves every owner-gated key as it is. */
async function fileRefusal(tool: string, input: JsonRecord, path: string, configFile: string, env: ServiceRoleGuardEnv): Promise<string | undefined> {
  const current = await env.readConfig(configFile);
  const next = nextText(tool, input, current);
  if (next === undefined) {
    return `this ${tool} of the team config (${path}) cannot be read as a change of its text, so the guard cannot tell whether it changes an owner-gated key`;
  }
  const changed = changedGatedKeys(current, next);
  return changed.length === 0 ? undefined : `this ${tool} changes ${changed.join(', ')} in the team config (${path})`;
}

/** True when the shell line names the team config file. */
function namesTeamConfig(command: string, cwd: string, env: ServiceRoleGuardEnv, configPath: string): boolean {
  if (TEAM_CONFIG_TAIL.test(command)) {
    return true;
  }
  if (!CONFIG_FILE_WORD.test(command)) {
    return false;
  }
  const home = samePathKey(kitHomeOf(configPath, env.platform), env.cwd, env.platform);
  const here = samePathKey(cwd, env.cwd, env.platform);
  return KIT_HOME_WORD.test(command) || here === home || here.startsWith(`${home}/`);
}

const ROLE_CHANGE_ASK =
  'teamrig service-role guard: `teamrig roles grant` and `revoke` change who may run a service role\'s commands past ' +
  'every permission check, a permission only the owner gives, so teamrig refuses it at every session\'s call, ' +
  'whatever --yes says. The owner runs it from their own terminal, where a grant first shows what its commands ' +
  'reach, pull requests and outside authors included; a session puts the change to its lead.';

function editRefusalOf(reach: string): string {
  return (
    `teamrig config guard: ${reach}. Its owner-gated keys (${OWNER_GATED_KEYS.map((keyPath) => keyPath.join('.')).join(', ')}) ` +
    'are permissions or owner gates, the owner\'s to change: a service role\'s holders with `teamrig roles grant` or ' +
    '`revoke`, which ask the owner, the rest in the owner\'s own editor. Change the config\'s other keys without touching ' +
    'them, read it with the Read tool, and do not retry this or route around it: the lead puts the change to the owner.'
  );
}

/**
 * The PreToolUse output for a Bash, PowerShell or file tool call: a refusal when it writes an owner-gated key or may (a
 * file tool on the team config, a shell line naming it), else an ask when it runs `teamrig roles grant` or `revoke`
 * through any client, else nothing, so the normal permission flow decides.
 */
export async function serviceRoleGuardOutput(payload: unknown, env: ServiceRoleGuardEnv): Promise<string> {
  if (!isRecord(payload)) {
    return '';
  }
  const tool = stringField(payload, 'tool_name') ?? '';
  const input = recordField(payload, 'tool_input') ?? {};
  const cwd = stringField(payload, 'cwd') ?? env.cwd;
  const field = FILE_WRITERS.get(tool);
  if (field !== undefined) {
    const path = stringField(input, field);
    if (path === undefined) {
      return '';
    }
    const alias = env.platform === 'win32' ? aliasFormOf(path) : undefined;
    if ((alias !== undefined && EXEC_LOG_NAME.test(openedNameOf(path))) || (await isExecLog(path, cwd, env))) {
      return refusalOutput(execLogRefusalOf(`this ${tool} writes ${path}, a team's exec audit log`));
    }
    if (alias !== undefined && CONFIG_NAME.test(openedNameOf(path))) {
      return refusalOutput(editRefusalOf(`this ${tool} names a config.json through ${alias} (${path}), a spelling the guard cannot hold to one file`));
    }
    const configFile = await teamConfigOf(path, cwd, env);
    if (configFile === undefined) {
      return '';
    }
    const reach = await fileRefusal(tool, input, path, configFile, env);
    return reach === undefined ? '' : refusalOutput(editRefusalOf(reach));
  }
  const command = stringField(input, 'command');
  if (!SHELLS.has(tool) || command === undefined) {
    return '';
  }
  if (namesExecLog(command, cwd, env)) {
    return refusalOutput(execLogRefusalOf(`this ${tool} line names a team's exec audit log, and a shell line's writes cannot be told from its reads`));
  }
  if (env.configPath !== undefined && namesTeamConfig(command, cwd, env, env.configPath)) {
    return refusalOutput(
      editRefusalOf(`this ${tool} line names the team config file, and a shell line's writes cannot be told from its reads`),
    );
  }
  const context: ProgramsContext = { cwd, home: env.home, dialect: tool === 'PowerShell' ? 'powershell' : 'bash' };
  const runs = runsOfReadings(toolCommandReadings(tool, command, env.platform), context);
  const changes =
    runs.programs.some((run) => {
      const launch = teamrigLaunchOf(run, startsRoleChange);
      return launch !== undefined && startsRoleChange(launch.words);
    }) || runs.opaque.some((run) => opaqueGuardedWords(run, startsRoleChange) !== undefined);
  return changes ? holdBackOutput('ask', ROLE_CHANGE_ASK) : '';
}
