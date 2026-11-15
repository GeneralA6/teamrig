import { posix, win32 } from 'node:path';
import type { HookAsks } from '../config/types.ts';
import { toolCommandReadings } from '../core/bash-tool-readings.ts';
import { isRecord, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import type { ProgramsContext } from '../package-guard/programs.ts';
import type { ShellWord } from '../push-guard/tokenizer.ts';
import { runsOfReadings, teamrigLaunchOf } from './exec-guard.ts';
import { holdBackOutput, refusalOutput } from './permission.ts';

/**
 * The service-role guard (T2984, security condition C2): a service role lets its holders run a few teamrig commands
 * past every permission check, so who holds one is a permission, an owner gate. A session's `teamrig roles grant` or
 * `revoke` therefore always asks the owner, whatever `--yes` says (refused when asks are off), and the route allow
 * never lets one through, as it allows only what every guard passed. A session's own write of `serviceRoles` is
 * refused: a file tool whose result changes the key in the team config, or cannot be read, and a shell line naming the
 * team config file at all, since a shell line's writes cannot be told from its reads (the Read tool stays open). Like
 * the pass-record guard it reads only the call: a script the session writes and starts still reaches the file, as
 * sessions and the owner share one account (stopgap T791). A teamrig call whose subcommand is only known when it runs,
 * and a shell fed by a pipe, are the exec guard's to refuse.
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

/** A team config path in a line: `teams/<team>/config.json`, any slash, a glob or variable as the team too. */
const TEAM_CONFIG_TAIL = /teams[\\/]+[^\s\\/'"]+[\\/]+config\.json(?![\w.-])/i;

/** `config.json` as a file name of its own: not `tsconfig.json` or `config.json5`. */
const CONFIG_FILE_WORD = /(?<![\w.-])config\.json(?![\w.-])/i;

/** A line reaching into the kit home: its folder, or the variable that moves it. */
const KIT_HOME_WORD = /(?<![\w-])\.teamrig(?![\w-])|TEAMRIG_HOME/i;

export interface ServiceRoleGuardEnv {
  /** The folder the call runs in when the payload names none. */
  readonly cwd: string;
  readonly home: string;
  readonly hookAsks: HookAsks;
  readonly platform: NodeJS.Platform;
  /** The team config file, or undefined when the hook found no team config to keep. */
  readonly configPath: string | undefined;
  /** The team config's text now, or undefined when there is none. */
  readonly readConfig: () => Promise<string | undefined>;
}

/** True when the words run `roles grant` or `roles revoke`, or a `roles` command only known when it runs. */
function startsRoleChange(words: readonly ShellWord[]): boolean {
  const [group, action] = words;
  return group !== undefined && !group.dynamic && group.text === 'roles' && action !== undefined && (action.dynamic || ROLE_CHANGES.has(action.text));
}

/** A path as the platform compares it: absolute against the folder, one slash, any case on Windows. */
function samePathKey(path: string, cwd: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? win32.resolve(cwd, path).replaceAll('\\', '/').toLowerCase() : posix.resolve(cwd, path);
}

/** The kit home a team config sits in: `<home>/teams/<team>/config.json`. */
function kitHomeOf(configPath: string, platform: NodeJS.Platform): string {
  const path = platform === 'win32' ? win32 : posix;
  return path.dirname(path.dirname(path.dirname(configPath)));
}

/** `serviceRoles` as the config loader reads it, as text to compare; null when the text holds none or is no config. */
function rolesKey(text: string | undefined): string {
  if (text === undefined) {
    return 'null';
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return 'null';
  }
  return isRecord(raw) ? JSON.stringify(raw['serviceRoles'] ?? null) : 'null';
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

/** Why a file tool's call on the team config is refused, or undefined when it leaves `serviceRoles` as it is. */
async function fileRefusal(tool: string, input: JsonRecord, path: string, env: ServiceRoleGuardEnv): Promise<string | undefined> {
  const current = await env.readConfig();
  const next = nextText(tool, input, current);
  if (next === undefined) {
    return `this ${tool} of the team config (${path}) cannot be read as a change of its text, so the guard cannot tell whether it changes serviceRoles`;
  }
  return rolesKey(next) === rolesKey(current) ? undefined : `this ${tool} changes serviceRoles in the team config (${path})`;
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
  'every permission check, a permission only the owner gives, so teamrig asks the owner at each session\'s call, ' +
  'whatever --yes says. Owner: allow it only if you asked for this change. A session does not retry it or route ' +
  'around it: the lead puts the change to the owner, who runs it from their own terminal or prompt.';

function editRefusalOf(reach: string): string {
  return (
    `teamrig service-role guard: ${reach}. Who holds a service role is the owner's to change, with ` +
    '`teamrig roles grant` or `revoke`, which ask the owner; change the config\'s other keys without touching ' +
    'serviceRoles, read it with the Read tool, and do not retry this or route around it.'
  );
}

/**
 * The PreToolUse output for a Bash, PowerShell or file tool call: a refusal when it writes `serviceRoles` or may (a
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
    if (path === undefined || env.configPath === undefined) {
      return '';
    }
    if (samePathKey(path, cwd, env.platform) !== samePathKey(env.configPath, cwd, env.platform)) {
      return '';
    }
    const reach = await fileRefusal(tool, input, path, env);
    return reach === undefined ? '' : refusalOutput(editRefusalOf(reach));
  }
  const command = stringField(input, 'command');
  if (!SHELLS.has(tool) || command === undefined) {
    return '';
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
    }) || runs.opaque.some((run) => startsRoleChange(run.args));
  return changes ? holdBackOutput('ask', ROLE_CHANGE_ASK, env.hookAsks) : '';
}
