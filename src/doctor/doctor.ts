import { isDefaultModel } from '../config/launch.ts';
import type { Roster } from '../config/roster.ts';
import { describeNameClash, describeTreeProblem, type NameClash, type TreeProblem } from '../config/tree.ts';
import type { ContextFilesConfig, KitConfig, LaunchConfig } from '../config/types.ts';
import { ENV, type Env } from '../core/home.ts';
import { isReservedName, RESERVED_RULE } from '../core/ids.ts';
import type { PathKind } from '../core/path-probe.ts';
import { MS_PER_DAY } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import { unreadSince } from '../inbox/inbox.ts';
import type { Unread } from '../inbox/unread.ts';
import type { RenameLogRead } from '../names/rename.ts';
import { wideAllowText } from '../permissions/report.ts';
import type { WideAllow } from '../permissions/trim.ts';
import { describeRequirement, type RequirementProblem } from '../requirements/requirements.ts';
import { TEAM_RULES_MAX_CHARS } from '../rules/pack.ts';
import type { ContextFiles } from './context-files.ts';
import type { SessionList, SessionListKind, SessionLists } from './session-lists.ts';
import type { SettingsEnv } from './settings-env.ts';
import type { ShellHistory } from './shell-history.ts';

/**
 * Days an inbox may wait with unread lines and no read before doctor flags it. Hard-coded for now;
 * a candidate config key if teams want it tighter or looser.
 */
export const UNREAD_INBOX_DAYS = 7;

/**
 * - `requirement`: something teamrig needs beside itself is missing or too old (git, Claude Code, Node.js);
 * - `name-gone`: a name of a session no longer on the team;
 * - `name-shared`: a current name two sessions share, or a session's former name another holds now;
 * - `name-config`: a config name the rename log never gave the session (the config was edited to rename);
 * - `name-reserved`: a session's current name Claude Code keeps for itself, so no message reaches it (an older rename
 *   record, or the default `<team>-<id>`);
 * - `rename-log`: damaged or newer lines in the rename log;
 * - `inbox-orphan`: an inbox no session on the team reads;
 * - `inbox-unread`: unread lines and no read for over `UNREAD_INBOX_DAYS` days;
 * - `rules-long`: a rules.md longer than a session is shown at start;
 * - `context-size`: CLAUDE.md files, a memory index or a skill listing over its `contextFiles` budget, re-read every call;
 * - `context-lists`: the lists the newest session's context holds (skills, deferred tools, agent types, MCP server
 *   instructions) over their `contextFiles` budget, re-read every call;
 * - `tree-id`, `tree-parent`, `tree-loop`, `tree-depth`, `tree-children`: a broken link in the
 *   team's tree of teams (see `TreeProblem`);
 * - `name-two-teams`: a session name this team shares with another team, though names are machine-wide;
 * - `effort-env`: `CLAUDE_CODE_EFFORT_LEVEL` set, which beats every `--effort`, `/effort` and per-call Agent effort;
 * - `model-env`: `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` set, which at 1 beats every per-call Agent model;
 * - `settings-json`: a Claude Code settings file that is not a JSON object, so its `env` block went unchecked;
 * - `launch-effort`: a session's `launch` names a model but no effort, so it starts at the model's default effort;
 * - `allow-wide`: local allow rules off `permissions.keepAllow` that approve a whole tool or program, so auto mode's
 *   classifier never sees those calls, or hold a credential saved with an approved command (`teamrig permissions trim`
 *   removes them, run by the owner);
 * - `project-missing`: a `team.project` or `launch.<id>.project` that is no folder on this machine, so a tab `open`
 *   starts there refuses to launch;
 * - `shell-history`: a PowerShell history file that keeps every line typed in the console, a credential in a URL too,
 *   while no PowerShell profile sets a history handler or turns saving off.
 */
export type FindingKind =
  | 'requirement'
  | 'name-gone'
  | 'name-shared'
  | 'name-config'
  | 'name-reserved'
  | 'rename-log'
  | 'inbox-orphan'
  | 'inbox-unread'
  | 'rules-long'
  | 'context-size'
  | 'context-lists'
  | TreeProblem['kind']
  | 'name-two-teams'
  | 'effort-env'
  | 'model-env'
  | 'settings-json'
  | 'launch-effort'
  | 'allow-wide'
  | 'project-missing'
  | 'shell-history';

/** A project folder the team config names, and what is at its path on this machine. */
export interface ConfiguredProject {
  /** The session whose `launch.<id>.project` it is; undefined for the team's `team.project`. */
  readonly session: string | undefined;
  readonly path: string;
  readonly kind: PathKind;
}

export interface Finding {
  readonly kind: FindingKind;
  readonly detail: string;
}

/** The wide allow rules of every settings file the team's sessions run under, as one finding. */
export interface AllowFinding extends Finding {
  readonly kind: 'allow-wide';
}

/** A context finding and the budget it runs over: at most one stands per budget, so the budget names it while it stands. */
export interface ContextFinding extends Finding {
  readonly kind: 'context-size' | 'context-lists';
  readonly budget: keyof ContextFilesConfig;
}

/** A session and the model and effort it starts on. */
export interface SessionLaunch {
  readonly id: string;
  /** As `launchOf` resolves it: the lead's unset keys filled in. */
  readonly launch: LaunchConfig;
}

export interface DoctorInput {
  /** What teamrig lacks on this machine (`RequirementsCheck`). */
  readonly requirements: readonly RequirementProblem[];
  readonly roster: Roster;
  /** The config's `names`, to spot a rename made by editing the config. */
  readonly configNames: KitConfig['names'];
  readonly renameLog: RenameLogRead & { readonly path: string };
  /** Every inbox, as `inbox status` reads it. */
  readonly inboxes: readonly Unread[];
  /**
   * The sessions `retire` took off the team and no hire brought back (the hire log). Their inboxes and former
   * names stay on purpose, readable by their id, so they are no orphan or gone name.
   */
  readonly retired: ReadonlySet<string>;
  /**
   * The rules.md files a session of the team is shown at start and their lengths: each team above it, root first,
   * then its own; those that exist.
   */
  readonly teamRules: readonly { readonly path: string; readonly chars: number }[];
  /** What every call of a session in the project re-reads, and the team's budgets for it. */
  readonly contextFiles: { readonly read: ContextFiles; readonly budgets: ContextFilesConfig };
  /** The lists the newest session in the project holds in its context (`readSessionLists`); undefined with no transcript. */
  readonly sessionLists: SessionLists | undefined;
  /** The problems of the team's tree of teams, and the session names it shares with other teams. */
  readonly tree: { readonly problems: readonly TreeProblem[]; readonly clashes: readonly NameClash[] };
  /** The environment doctor runs in; only the variables that override a model or effort choice are read. */
  readonly env: Env;
  /** The local allow rules off `permissions.keepAllow` that approve a whole tool or program or hold a credential (`readWideAllow`), as counts. */
  readonly wideAllow: WideAllow;
  /** The `env` blocks of the Claude Code settings files the team's sessions read (`readSettingsEnv`). */
  readonly settingsEnv: readonly SettingsEnv[];
  /** Each session on the team and the model and effort it starts on. */
  readonly launches: readonly SessionLaunch[];
  /** The project folders the config names, `team.project` first, then each `launch.<id>.project`. */
  readonly projects: readonly ConfiguredProject[];
  /** The user's PowerShell history file and profiles (`readShellHistory`). */
  readonly shellHistory: ShellHistory;
  readonly now: Date;
  /** The team's clock, which the findings' times are shown on. */
  readonly zone: TimeZone;
  /** The CLI name the fixes tell the user to run. */
  readonly command: string;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * Names that find the wrong session, or none: a removed session's (not a retired one's), a shared current one, a
 * former one taken over, a current one no message reaches.
 */
function nameFindings(input: DoctorInput): Finding[] {
  const { roster, command, retired } = input;
  const findings: Finding[] = [];
  const gone = new Map<string, string[]>();
  const shared = new Set<string>();
  for (const [name, holder] of roster.allNames()) {
    if (!roster.ids.includes(holder)) {
      if (!retired.has(holder)) {
        gone.set(holder, [...(gone.get(holder) ?? []), name]);
      }
      continue;
    }
    const current = roster.idsCalled(name);
    if (current.length > 1) {
      shared.add(name);
    } else if (current.length === 1 && !current.includes(holder)) {
      findings.push({ kind: 'name-shared', detail: `${name} was a name of ${holder} but is now the name of ${current.join(', ')}, so it no longer finds ${holder}` });
    }
  }
  for (const name of shared) {
    const ids = roster.idsCalled(name).join(', ');
    findings.push({ kind: 'name-shared', detail: `${name} is the name of ${ids}, so commands refuse it: give each its own with \`${command} rename\`` });
  }
  for (const [id, names] of gone) {
    const these = plural(names.length, 'was a name', 'were names');
    findings.push({ kind: 'name-gone', detail: `${names.join(', ')} ${these} of ${id}, which is no longer on the team: commands refuse them, filters read them as ${id}` });
  }
  for (const id of roster.ids) {
    const name = roster.nameOf(id);
    if (name !== undefined && isReservedName(name)) {
      findings.push({ kind: 'name-reserved', detail: `${name} (session ${id}) ${RESERVED_RULE}: give the tab another name with /rename, then record it with \`${command} rename ${id} <name>\`` });
    }
  }
  return findings;
}

/** A config name the rename log never gave the session: someone edited the config to rename it, and the log wins. */
function configFindings(input: DoctorInput): Finding[] {
  const { roster, renameLog, command } = input;
  return Object.entries(input.configNames).flatMap(([id, configured]): Finding[] => {
    const current = roster.nameOf(id);
    const logged = renameLog.renames.some((rename) => rename.id === id && (rename.from === configured || rename.to === configured));
    if (current === undefined || current === configured || logged) {
      return [];
    }
    const detail = `the config names ${id} "${configured}", but the rename log calls it ${current} and the log wins: to rename it, run \`${command} rename ${id} ${configured}\``;
    return [{ kind: 'name-config', detail }];
  });
}

function renameLogFindings(input: DoctorInput): Finding[] {
  const { path, unreadable, newer } = input.renameLog;
  const findings: Finding[] = [];
  if (unreadable > 0) {
    findings.push({ kind: 'rename-log', detail: `${path} has ${unreadable} damaged line(s), skipped: the names they record do not resolve until fixed` });
  }
  if (newer > 0) {
    findings.push({ kind: 'rename-log', detail: `${path} has ${newer} line(s) from a newer ${input.command}, skipped: no rename can be recorded until ${input.command} is updated` });
  }
  return findings;
}

/** When an inbox started waiting: its last read, else its first unread line; undefined when neither is known. */
function waitingSince(unread: Unread): Date | undefined {
  if (unread.mark !== null) {
    return new Date(unread.mark.at);
  }
  return unreadSince(unread);
}

/** Inboxes nobody reads: one keyed by no session id on the team (nor a retired one's), or unread lines with no read for days. */
function inboxFindings(input: DoctorInput): Finding[] {
  const { roster, now, retired, zone } = input;
  return input.inboxes.flatMap((unread): Finding[] => {
    const { area, mark } = unread;
    const count = unread.lines.length;
    if (retired.has(area)) {
      return [];
    }
    if (!roster.ids.includes(area)) {
      const found = roster.lookup(area);
      const hint = found.ok ? `; ${area} is a name of ${found.id}, whose inbox is keyed by its id` : '';
      const detail = `inbox ${area} (${count} unread) is no session's: inboxes are keyed by session id, so nobody reads it${hint}; nothing moves its lines`;
      return [{ kind: 'inbox-orphan', detail }];
    }
    const since = waitingSince(unread);
    if (count === 0 || (since !== undefined && now.getTime() - since.getTime() <= UNREAD_INBOX_DAYS * MS_PER_DAY)) {
      return [];
    }
    const read = mark === null ? 'has never read it' : `last read it ${zone.shortMinute(new Date(mark.at))}`;
    return [{ kind: 'inbox-unread', detail: `${area} has ${count} unread line(s) and ${read}: over ${UNREAD_INBOX_DAYS} days with no read` }];
  });
}

/**
 * Each team rules file a session gets only a pointer to, as `renderSessionContext` shares TEAM_RULES_MAX_CHARS: in
 * order, a file is shown while it fits beside the files shown before it, so a file that fits alone is named with them.
 */
function rulesFindings(input: DoctorInput): Finding[] {
  const shown: string[] = [];
  let used = 0;
  const findings: Finding[] = [];
  for (const rules of input.teamRules) {
    if (rules.chars === 0) {
      continue;
    }
    if (used + rules.chars <= TEAM_RULES_MAX_CHARS) {
      shown.push(rules.path);
      used += rules.chars;
      continue;
    }
    const detail =
      rules.chars > TEAM_RULES_MAX_CHARS
        ? `${rules.path} is ${rules.chars} characters, more than the ${TEAM_RULES_MAX_CHARS} a session is shown at start, so sessions get only a pointer to it: shorten it to keep it in every session's context`
        : `${rules.path} is ${rules.chars} characters, but the team rules shown before it (${shown.join(', ')}) take ${used} of the ${TEAM_RULES_MAX_CHARS} a session is shown at start, so sessions get only a pointer to it: shorten one of them`;
    findings.push({ kind: 'rules-long', detail });
  }
  return findings;
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

/** At about 4 characters a token, rounded to the hundred: enough to weigh a cut. */
function tokensOf(chars: number): string {
  return `~${count(Math.round(chars / 400) * 100)} tokens`;
}

function sizeFinding(what: string, chars: number, budget: number, key: keyof ContextFilesConfig, fix: string): ContextFinding[] {
  if (chars <= budget) {
    return [];
  }
  const detail = `${what}: ${count(chars)} characters (${tokensOf(chars)}), over its budget of ${count(budget)} [contextFiles.${key}]; every call re-reads this text, so ${fix}`;
  return [{ kind: 'context-size', detail, budget: key }];
}

/** What the context findings weigh: the files every call re-reads, and the lists the newest session's context holds. */
export type ContextInput = Pick<DoctorInput, 'contextFiles' | 'sessionLists'>;

function contextFindings({ contextFiles: { read, budgets } }: ContextInput): ContextFinding[] {
  const claudeMdChars = read.claudeMd.reduce((sum, file) => sum + file.chars, 0);
  const claudeMd = read.claudeMd.map((file) => `${file.path} ${count(file.chars)}`).join(', ');
  const memory = read.memoryIndex;
  const skills = `skill listing (${read.skills.count} skills in ${read.skills.folders.join(', ')})`;
  return [
    ...sizeFinding(`CLAUDE.md files (${claudeMd})`, claudeMdChars, budgets.maxClaudeMdChars, 'maxClaudeMdChars', 'move how-tos into skills and facts into memory files'),
    ...(memory === undefined
      ? []
      : sizeFinding(`memory index ${memory.path}`, memory.chars, budgets.maxMemoryIndexChars, 'maxMemoryIndexChars', 'keep one short line per memory and its detail in the memory file')),
    ...sizeFinding(skills, read.skills.chars, budgets.maxSkillListingChars, 'maxSkillListingChars', 'shorten descriptions or merge skills'),
  ];
}

const SESSION_LIST_LABELS: Readonly<Record<SessionListKind, string>> = {
  skills: 'skills',
  tools: 'deferred tools',
  agents: 'agent types',
  instructions: 'MCP instructions',
};

/** The largest sources a list names; the rest are counted. */
const SESSION_LIST_TOP_SOURCES = 3;

function describeSessionList(list: SessionList): string {
  const top = list.sources.slice(0, SESSION_LIST_TOP_SOURCES).map((source) => `${source.name} ${count(source.chars)}`);
  const rest = list.sources.length - top.length;
  const sources = rest > 0 ? [...top, `+${rest} more`] : top;
  const breakdown = sources.length === 0 ? '' : ` (${sources.join(', ')})`;
  return `${SESSION_LIST_LABELS[list.kind]} ${list.count}, ${count(list.chars)}${breakdown}`;
}

function sessionListsFinding({ sessionLists, contextFiles: { budgets } }: ContextInput): ContextFinding[] {
  if (sessionLists === undefined) {
    return [];
  }
  const lists = sessionLists.lists.filter((list) => list.count > 0);
  const chars = lists.reduce((sum, list) => sum + list.chars, 0);
  const budget = budgets.maxSessionListsChars;
  if (chars <= budget) {
    return [];
  }
  const detail =
    `lists in the context of the newest session (${sessionLists.transcript}): ${count(chars)} characters (${tokensOf(chars)}), ` +
    `over its budget of ${count(budget)} [contextFiles.maxSessionListsChars]: ${lists.map(describeSessionList).join('; ')}; ` +
    'every call re-reads this text, so turn off unused claude.ai connectors and skills in claude.ai settings, and unused plugins with /plugin';
  return [{ kind: 'context-lists', detail, budget: 'maxSessionListsChars' }];
}

/**
 * The `context-size` and `context-lists` findings: text every call of a session on this machine re-reads, over its
 * `contextFiles` budget. That text is no one area's, so `check` prints them as warnings no session owns, which go to
 * the lead (src/cli/unowned.ts, T951), not only in `doctor`.
 */
export function contextSizeFindings(input: ContextInput): ContextFinding[] {
  return [...contextFindings(input), ...sessionListsFinding(input)];
}

function treeFindings({ tree, command }: DoctorInput): Finding[] {
  return [
    ...tree.problems.map((problem): Finding => ({ kind: problem.kind, detail: describeTreeProblem(problem, command) })),
    ...tree.clashes.map((clash): Finding => ({ kind: 'name-two-teams', detail: describeNameClash(clash, command) })),
  ];
}

/** A variable that overrides a choice made anywhere else, and what it does to the sessions and helpers that get it. */
interface RoutingOverride {
  readonly kind: 'effort-env' | 'model-env';
  readonly name: string;
  readonly effect: (value: string) => string;
}

const ROUTING_OVERRIDES: readonly RoutingOverride[] = [
  {
    kind: 'effort-env',
    name: ENV.effortLevel,
    effect: (value) => `it beats every --effort (the team config's launch efforts among them), /effort and per-call Agent effort, so a session or helper that gets it runs at ${value} whatever it was given`,
  },
  {
    kind: 'model-env',
    name: ENV.subagentModelForce,
    effect: () => 'set to 1 it beats every per-call Agent model, so a helper that gets it never runs on the model its caller gives it',
  },
];

/**
 * A variable set in doctor's own environment or in a settings file's `env` block that overrides every effort or
 * helper model a session or its caller picks, and a settings file whose block could not be read. Only the
 * overriding variables' values are printed.
 */
function routingEnvFindings({ env, settingsEnv }: DoctorInput): Finding[] {
  const sources = [
    { where: 'the environment doctor runs in', env },
    ...settingsEnv.flatMap((settings) => (settings.kind === 'env' ? [{ where: `the env block of ${settings.path}`, env: settings.env }] : [])),
  ];
  const overrides = ROUTING_OVERRIDES.flatMap(({ kind, name, effect }) =>
    sources.flatMap(({ where, env: set }): Finding[] => {
      const value = set[name]?.trim();
      return value ? [{ kind, detail: `${name}=${value} is set in ${where}: ${effect(value)}; unset it there to let each choose its own` }] : [];
    }),
  );
  const names = ROUTING_OVERRIDES.map(({ name }) => name).join(' or ');
  const unreadable = settingsEnv.flatMap((settings): Finding[] =>
    settings.kind === 'unreadable' ? [{ kind: 'settings-json', detail: `${settings.path} is not a JSON object, so doctor could not check its env block for ${names}` }] : [],
  );
  return [...overrides, ...unreadable];
}

/** A session whose launch names a model but no effort: it starts at that model's default effort, whatever the team meant. */
function launchFindings({ launches, roster }: DoctorInput): Finding[] {
  return launches.flatMap(({ id, launch }): Finding[] => {
    if (isDefaultModel(launch.model) || launch.effort !== undefined) {
      return [];
    }
    const name = roster.nameOf(id) ?? id;
    const detail = `${name} (session ${id}) launches on model ${launch.model} with no effort, so it runs at that model's default effort (medium on Opus, Sonnet and Haiku 5.5): set launch.${id}.effort in the team config`;
    return [{ kind: 'launch-effort', detail }];
  });
}

/** One finding while any settings file holds a wide allow rule off the keep-list, counted by class, never its text; `check` shows it the lead too. */
export function allowFindings(wide: WideAllow): AllowFinding[] {
  const detail = wideAllowText(wide);
  return detail === undefined ? [] : [{ kind: 'allow-wide', detail }];
}

/** A configured project folder that is a file or nothing: `launch` refuses a tab's folder that is no folder (src/cli/commands/open.ts). */
function projectFindings({ projects, roster, command }: DoctorInput): Finding[] {
  return projects.flatMap(({ session, path, kind }): Finding[] => {
    if (kind === 'folder') {
      return [];
    }
    const key = session === undefined ? 'team.project' : `launch.${session}.project`;
    const who = session === undefined ? 'a session without its own folder' : `${roster.nameOf(session) ?? session} (session ${session})`;
    const what = kind === 'file' ? 'a file' : 'missing';
    const detail = `${key} names ${path}, which is ${what} on this machine, so a tab ${command} open starts for ${who} refuses to launch: create the folder or fix ${key} in the team config`;
    return [{ kind: 'project-missing', detail }];
  });
}

/**
 * A PowerShell history file no profile gates: PSReadLine saves each typed line to it, a credential in a URL too, where
 * any local process can read it. The fix is the user's own, as Claude Code refuses an agent's write to a profile.
 */
function shellHistoryFindings({ shellHistory: { history, profiles, gated } }: DoctorInput): Finding[] {
  if (history === undefined || gated) {
    return [];
  }
  const read = profiles.length === 0 ? 'none of the usual profile paths exists' : `profiles read: ${profiles.join(', ')}`;
  const detail =
    `PowerShell keeps each line typed in its console in ${history}, a credential in a URL too, and no profile sets -AddToHistoryHandler or -HistorySaveStyle SaveNothing (${read}): ` +
    "add the history handler from the teamrig guide (workflows: Use a secret by reference) to your profile ($PROFILE) yourself; Claude Code refuses an agent's write to it";
  return [{ kind: 'shell-history', detail }];
}

/**
 * The team's health checks: names that find the wrong session or none, a damaged rename log,
 * inboxes nobody reads, rules too long to show, text every call re-reads over its budget (files, and the lists the newest
 * session holds), a broken tree of teams or a session name two teams use, a variable that overrides every model or effort
 * choice, a launch with a model but no effort, local allow rules that approve a whole tool or program or hold a credential, a
 * configured project folder that is no folder here, and a PowerShell history no profile keeps credentials out of.
 * It reads only; every fix is the user's.
 */
export function doctorFindings(input: DoctorInput): Finding[] {
  return [
    ...input.requirements.map((problem): Finding => ({ kind: 'requirement', detail: describeRequirement(problem, input.command) })),
    ...nameFindings(input),
    ...configFindings(input),
    ...renameLogFindings(input),
    ...inboxFindings(input),
    ...rulesFindings(input),
    ...contextSizeFindings(input),
    ...treeFindings(input),
    ...routingEnvFindings(input),
    ...launchFindings(input),
    ...allowFindings(input.wideAllow),
    ...projectFindings(input),
    ...shellHistoryFindings(input),
  ];
}

export function formatFinding(finding: Finding): string {
  return `WARN ${finding.kind} ${finding.detail}`;
}
