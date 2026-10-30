import { basename } from 'node:path';
import { WEB_FETCH_TOOL, type ToolUse } from '../budget/line.ts';
import { kindOf } from '../budget/patterns.ts';
import { runWorkOf, SHELL_DIALECTS } from '../budget/run-work.ts';
import { programsOf, type ProgramRun } from '../package-guard/programs.ts';
import type { ShellDialect } from '../push-guard/tokenizer.ts';
import { TASK_ID } from '../register/model.ts';

/**
 * Work the lead hands off instead of doing (T320): an edit outside its own files, a test or a build, a
 * code search, and research (T736): a web page or search, or a search of another session's places in the
 * team's folder. Deciding, briefing and reading results, boards and docs are its job and are not counted.
 */
export type LeadWork = 'edit' | 'check' | 'search' | 'research';

/**
 * What one program a shell call starts does for the lead boundary, read the way the budget reads it (`runWorkOf`):
 * words inside a quoted argument, such as a `teamrig add --description` that quotes `git commit`, run nothing
 * (T483, T505). `git` is an edit by a git step that changes a repository.
 */
type LeadRunWork = LeadWork | 'git';

/** A source file: reading one is research. */
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|rb|php|sh|ps1|sql)$/i;
const SEARCH_TOOLS: ReadonlySet<string> = new Set(['Grep', 'Glob']);
const WEB_SEARCH_TOOL = 'WebSearch';
/** The turn-end line names this many edited files or research lookups, then counts the rest; a research nudge names this many owners. */
const MAX_NAMES = 3;
const HAND_OFF =
  'The lead hands such work to the owning session (a register task), a helper or a hired worker, and keeps to deciding and briefing [leadBoundary].';

/** A path or command with forward slashes, the home spellings (`~`, `$HOME`, `$env:USERPROFILE`) and Git Bash drives (`/c/`) written out, in lower case. */
function normalized(text: string, home: string): string {
  return text
    .replace(/\\+/g, '/')
    .replace(/\$\{?HOME\}?|\$env:USERPROFILE|~(?=\/|$)/gi, () => home)
    .replace(/(^|[\s"'=])\/([a-z])\//gi, (_match: string, before: string, drive: string) => `${before}${drive}:/`)
    .toLowerCase();
}

/** The lead's own files and folders (board, notes, agenda, memory): editing or searching them is its job. */
export class OwnPaths {
  /** The user's home, with forward slashes. */
  readonly home: string;
  private readonly within: readonly RegExp[];
  private readonly mentioned: readonly RegExp[];

  /** Each glob may start with `~` for the user's home and use `*` for one folder name. */
  constructor(globs: readonly string[], userHome: string) {
    this.home = userHome.replace(/\\+/g, '/').replace(/\/+$/, '');
    const patterns = globs
      .map((glob) => normalized(glob.trim(), this.home).replace(/\/+$/, ''))
      .filter((glob) => glob !== '')
      .map((glob) => glob.replace(/[.+?^${}()|[\]]/g, '\\$&').replace(/\*/g, '[^/]*'));
    this.within = patterns.map((pattern) => new RegExp(`^${pattern}(?:/|$)`));
    this.mentioned = patterns.map((pattern) => new RegExp(`${pattern}(?:/|$|[\\s"';|&)])`, 'm'));
  }

  /** The path is one of the lead's own files or folders, or inside one. */
  owns(path: string): boolean {
    const target = normalized(path, this.home);
    return this.within.some((pattern) => pattern.test(target));
  }

  /** The shell command names one of the lead's own files or folders. */
  named(command: string): boolean {
    const text = normalized(command, this.home);
    return this.mentioned.some((pattern) => pattern.test(text));
  }
}

/** A search of the team's folder, or a sub-team's, that is research. */
export interface TeamResearch {
  /**
   * What it searched, relative to the team's folder and at most two folders deep (`notes/symbols`); in a sub-team's
   * folder, after that team's id (`web/notes/front`).
   */
  readonly name: string;
  /**
   * The other session the path names, which owns what the search looks for, and for a sub-team's folder the address
   * of the child team's lead it hangs under; undefined for a shared folder of the lead's own team.
   */
  readonly owner: string | undefined;
  /** The task whose folder the search looks through (`tasks/T<id>`, T1467), whose owner `owner` is when the register holds it. */
  readonly task?: string;
}

/** A team below the lead's own in the team tree, whose folder a search of is research for its child team's lead (T1019). */
export interface SubTeamPlace {
  /** The team's id, which starts the research's name. */
  readonly team: string;
  /** The team's teamrig folder. */
  readonly home: string;
  /** Its config, its rules and the register's state: the parent lead reads those as it reads its own. */
  readonly own: readonly string[];
  /**
   * The address of the child team's lead the team hangs under (`web/lead`, for `ui` under `web` too): a parent lead
   * adds tasks only to its child teams, so the question goes there.
   */
  readonly owner: string;
}

/** The team's folder and the lead's own places in it, for `TeamFolders`. */
export interface TeamPlaces {
  /** The team's teamrig folder (`<kit home>/teams/<team>`). */
  readonly home: string;
  /** The lead's own files and folders there besides those named for it: the team config, its rules, the register's state. */
  readonly own: readonly string[];
  readonly lead: string;
  /** Every session of the team; a path segment named for one other than the lead (`notes/po`, `handover/po.md`) is its place. */
  readonly sessions: readonly string[];
  /** Every team below this one in the team tree; none for a team with no child team. */
  readonly subTeams: readonly SubTeamPlace[];
  /** The folder holding the team's task folders, `tasks/T<id>` (T1457). */
  readonly tasks: string;
  /**
   * The owner of each task by its id, from the register, for the task folders the lead searches (T1467): the lead's
   * own task's folder is its place, another session's is that session's; a task it does not hold has no owner.
   */
  readonly taskOwners: ReadonlyMap<string, string>;
}

const PATH_END = `(?=/|$|[\\s"';|&)])`;

/** A sub-team's place with its folders normalized as `TeamFolders` compares them. */
interface SubTeamFolder {
  readonly team: string;
  readonly root: string;
  readonly own: readonly string[];
  readonly owner: string;
}

/** The normalized path is the normalized place or inside it. */
function within(target: string, place: string): boolean {
  return target === place || target.startsWith(`${place}/`);
}

/** The path's folders below `root`, which holds it. */
function segmentsBelow(target: string, root: string): string[] {
  return target === root ? [] : target.slice(root.length + 1).split('/');
}

/**
 * The team's teamrig folder as the lead boundary reads a search of it (T736). The lead's own places there are its
 * config, its rules, the register's state, anything named for the lead and the folders of its own tasks (T1467); a
 * search anywhere else there (another session's notes, handover or task folder, or a shared folder such as all the
 * notes) is research, which the session that owns the question does. So is a search of a sub-team's folder outside
 * its config, rules and state (T1019), which the child team's lead it hangs under answers.
 */
export class TeamFolders {
  private readonly root: string;
  private readonly own: readonly string[];
  private readonly lead: string;
  private readonly others: ReadonlySet<string>;
  private readonly subTeams: readonly SubTeamFolder[];
  private readonly tasks: string;
  private readonly taskOwners: ReadonlyMap<string, string>;
  private readonly home: string;
  private readonly mentioned: RegExp;

  constructor(places: TeamPlaces, userHome: string) {
    this.home = userHome.replace(/\\+/g, '/').replace(/\/+$/, '');
    this.root = this.placeOf(places.home);
    this.own = places.own.map((place) => this.placeOf(place));
    this.lead = places.lead.toLowerCase();
    this.others = new Set(places.sessions.map((id) => id.toLowerCase()).filter((id) => id !== this.lead));
    this.subTeams = places.subTeams.map(({ team, home, own, owner }) => ({ team, root: this.placeOf(home), own: own.map((place) => this.placeOf(place)), owner }));
    this.tasks = this.placeOf(places.tasks);
    this.taskOwners = places.taskOwners;
    const roots = [this.root, ...this.subTeams.map((sub) => sub.root)].map((root) => root.replace(/[.+?^${}()|[\]\\*]/g, '\\$&'));
    this.mentioned = new RegExp(`(?:${roots.join('|')})${PATH_END}(?:/[^\\s"';|&)]*)?`, 'g');
  }

  private placeOf(path: string): string {
    return normalized(path.trim(), this.home).replace(/\/+$/, '');
  }

  /** The sub-team whose folder holds the path, the deepest when folders nest; undefined when the lead's own folder holds it deeper. */
  private subTeamOf(target: string): SubTeamFolder | undefined {
    const holder = this.subTeams
      .filter((sub) => within(target, sub.root))
      .reduce<SubTeamFolder | undefined>((deepest, sub) => (deepest === undefined || sub.root.length > deepest.root.length ? sub : deepest), undefined);
    return holder !== undefined && !(within(target, this.root) && this.root.length > holder.root.length) ? holder : undefined;
  }

  /** The task whose folder holds the path, in the register's spelling (`T12`); undefined outside a task folder. */
  private taskOf(target: string): string | undefined {
    const id = within(target, this.tasks) ? segmentsBelow(target, this.tasks)[0]?.toUpperCase() : undefined;
    return id !== undefined && TASK_ID.test(id) ? id : undefined;
  }

  /**
   * The research a search of `path` is; undefined outside the team's and its sub-teams' folders, in the lead's own
   * places, in its own task's folder and in a sub-team's config, rules and state.
   */
  researchOf(path: string): TeamResearch | undefined {
    const target = this.placeOf(path);
    const sub = this.subTeamOf(target);
    if (sub !== undefined) {
      return sub.own.some((place) => within(target, place)) ? undefined : { name: [sub.team, ...segmentsBelow(target, sub.root).slice(0, 2)].join('/'), owner: sub.owner };
    }
    if (!within(target, this.root) || this.own.some((place) => within(target, place))) {
      return undefined;
    }
    const segments = segmentsBelow(target, this.root);
    const task = this.taskOf(target);
    if (task !== undefined) {
      const owner = this.taskOwners.get(task);
      return owner?.toLowerCase() === this.lead ? undefined : { name: segments.slice(0, 2).join('/'), owner, task };
    }
    const named = segments.map((segment) => segment.replace(/\.md$/, ''));
    if (named.includes(this.lead)) {
      return undefined;
    }
    return { name: segments.slice(0, 2).join('/') || 'the team folder', owner: named.find((segment) => this.others.has(segment)) };
  }

  /** The research a shell search is, from the first path in the team's or a sub-team's folder it names that is research. */
  researchNamed(command: string): TeamResearch | undefined {
    for (const match of normalized(command, this.home).matchAll(this.mentioned)) {
      const research = this.researchOf(match[0]);
      if (research !== undefined) {
        return research;
      }
    }
    return undefined;
  }
}

/** Where the lead's calls land: its own places, and the team's and its sub-teams' folders, where other places are research. */
export interface LeadPaths {
  readonly own: OwnPaths;
  readonly team: TeamFolders;
}

/** What one program a shell call starts does that the lead hands off; undefined for anything else. */
function leadRunWorkOf(run: ProgramRun): LeadRunWork | undefined {
  switch (runWorkOf(run)) {
    case 'edit':
      return 'edit';
    case 'gitPatch':
    case 'gitWrite':
      return 'git';
    case 'testFull':
    case 'testTargeted':
    case 'build':
      return 'check';
    case 'search':
      return 'search';
    default:
      return undefined;
  }
}

/**
 * A call's hand-off work, with the name the turn-end line gives it: an edit's file, else `git` or `shell`; research's
 * web host, `a web search` or team folder. `owner` is the session whose place a team-folder search looks through, and
 * `task` the task whose folder it is.
 */
interface CallWork {
  readonly work: LeadWork;
  readonly name: string;
  readonly owner?: string;
  readonly task?: string;
}

function researchWork({ name, owner, task }: TeamResearch): CallWork {
  return { work: 'research', name, ...(owner === undefined ? {} : { owner }), ...(task === undefined ? {} : { task }) };
}

/**
 * A shell call by the programs it starts: an edit before a test or build before research before a search; a line
 * naming the lead's own files is its job, and a search naming another session's place in the team's folder research.
 */
function shellWorkOf(command: string, dialect: ShellDialect, paths: LeadPaths): CallWork | undefined {
  const { own, team } = paths;
  const works = new Set(programsOf(command, { cwd: undefined, home: own.home, dialect }).map(leadRunWorkOf));
  if (works.has('git') || works.has('edit')) {
    return own.named(command) ? undefined : { work: 'edit', name: works.has('git') ? 'git' : 'shell' };
  }
  if (works.has('check')) {
    return { work: 'check', name: 'shell' };
  }
  if (!works.has('search')) {
    return undefined;
  }
  const research = team.researchNamed(command);
  if (research !== undefined) {
    return researchWork(research);
  }
  return own.named(command) ? undefined : { work: 'search', name: 'shell' };
}

/** A web address's host, the name its research has; `a web page` for one that does not parse. */
function hostOf(url: string | undefined): string {
  return url !== undefined && URL.canParse(url) ? new URL(url).host : 'a web page';
}

function callWorkOf(tool: ToolUse, paths: LeadPaths): CallWork | undefined {
  if (tool.name === WEB_FETCH_TOOL) {
    return { work: 'research', name: hostOf(tool.url) };
  }
  if (tool.name === WEB_SEARCH_TOOL) {
    return { work: 'research', name: 'a web search' };
  }
  const dialect = SHELL_DIALECTS.get(tool.name);
  if (dialect !== undefined) {
    return shellWorkOf(tool.command ?? '', dialect, paths);
  }
  const path = tool.path;
  const mine = path !== undefined && paths.own.owns(path);
  const name = path === undefined ? 'shell' : basename(path.replace(/\\/g, '/'));
  if (kindOf(tool) === 'edit') {
    return mine ? undefined : { work: 'edit', name };
  }
  if (tool.name === 'Read') {
    return path !== undefined && CODE_FILE.test(path) && !mine ? { work: 'search', name } : undefined;
  }
  if (!SEARCH_TOOLS.has(tool.name)) {
    return undefined;
  }
  const research = path === undefined ? undefined : paths.team.researchOf(path);
  if (research !== undefined) {
    return researchWork(research);
  }
  return mine ? undefined : { work: 'search', name };
}

/** What one of the lead's calls did that it hands off; undefined for its own job. */
export function leadWorkOf(tool: ToolUse, paths: LeadPaths): LeadWork | undefined {
  return callWorkOf(tool, paths)?.work;
}

/**
 * The tasks whose folders the calls search as research, each once: the register is read for their owners only when
 * there are some (T1467), since `paths` without an owner reads the lead's own task's folder as research too.
 */
export function tasksSearched(turn: readonly ToolUse[], paths: LeadPaths): string[] {
  const tasks: string[] = [];
  for (const tool of turn) {
    const task = callWorkOf(tool, paths)?.task;
    if (task !== undefined) {
      addOnce(tasks, task);
    }
  }
  return tasks;
}

/** The lead's hand-off work in one turn. */
export interface LeadTally {
  readonly edits: number;
  /** The edited files' names in order, each once; `git` or `shell` for a step that names no file. */
  readonly edited: readonly string[];
  readonly checks: number;
  readonly searches: number;
  readonly research: number;
  /** What the research looked up in order, each once: a web host, `a web search` or a team folder. */
  readonly researched: readonly string[];
}

function addOnce(names: string[], name: string): void {
  if (!names.includes(name)) {
    names.push(name);
  }
}

/** The hand-off work among a turn's calls. */
export function leadTallyOf(turn: readonly ToolUse[], paths: LeadPaths): LeadTally {
  let edits = 0;
  let checks = 0;
  let searches = 0;
  let research = 0;
  const edited: string[] = [];
  const researched: string[] = [];
  for (const tool of turn) {
    const call = callWorkOf(tool, paths);
    switch (call?.work) {
      case 'edit':
        edits += 1;
        addOnce(edited, call.name);
        break;
      case 'check':
        checks += 1;
        break;
      case 'search':
        searches += 1;
        break;
      case 'research':
        research += 1;
        addOnce(researched, call.name);
        break;
      case undefined:
        break;
    }
  }
  return { edits, edited, checks, searches, research, researched };
}

/**
 * The sessions that own the tasks a turn's prompt names, other than the lead: whom the lead's research belongs to.
 * Each once, in the prompt's order, at most `MAX_NAMES`; a task the register does not hold is skipped.
 */
export function taskOwnersOf(ids: readonly string[], tasks: ReadonlyMap<string, { readonly owner: string }>, lead: string): string[] {
  const owners: string[] = [];
  for (const id of ids) {
    const owner = tasks.get(id)?.owner;
    if (owner !== undefined && owner !== lead) {
      addOnce(owners, owner);
    }
  }
  return owners.slice(0, MAX_NAMES);
}

/** The research nudge: the owner a team-folder search names, else the owners of the prompt's tasks, else the generic owner. */
function researchLine(call: CallWork, askOwners: readonly string[]): string {
  const owners = call.owner === undefined ? askOwners : [call.owner];
  const to = owners.length === 0 ? 'the session that owns it' : owners.join(' or ');
  return `teamrig: the lead did research itself (${call.name}). Send the question to ${to} as a register task with a deadline and relay its answer [leadBoundary].`;
}

/**
 * The line for the lead's model after `current`, once a turn per kind: at its first edit, its first
 * test or build, its first research and its `searchNudgeAt`-th code search (0: never for searches).
 * `turn` includes `current`; `askOwners` are the sessions a research nudge names when the call names none
 * (`taskOwnersOf` the turn's prompt).
 */
export function leadNudgeLine(turn: readonly ToolUse[], current: ToolUse, paths: LeadPaths, searchNudgeAt: number, askOwners: readonly string[] = []): string | undefined {
  const tally = leadTallyOf(turn, paths);
  const call = callWorkOf(current, paths);
  switch (call?.work) {
    case 'edit':
      return tally.edits === 1 ? `teamrig: the lead edited ${call.name} itself. ${HAND_OFF}` : undefined;
    case 'check':
      return tally.checks === 1 ? `teamrig: the lead ran a test or a build itself. ${HAND_OFF}` : undefined;
    case 'search':
      return searchNudgeAt > 0 && tally.searches === searchNudgeAt ? `teamrig: the lead made ${searchNudgeAt} code searches itself this turn. ${HAND_OFF}` : undefined;
    case 'research':
      return tally.research === 1 ? researchLine(call, askOwners) : undefined;
    case undefined:
      return undefined;
  }
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Up to `MAX_NAMES` names, then how many more. */
function namesOf(names: readonly string[]): string {
  const more = names.length - MAX_NAMES;
  return names.slice(0, MAX_NAMES).join(', ') + (more > 0 ? ` +${more} more` : '');
}

/** The owner's turn-end line when the lead did hand-off work itself; searches count from `searchNudgeAt` (0: never). */
export function leadStopLine(tally: LeadTally, searchNudgeAt: number): string | undefined {
  const parts = [
    ...(tally.edits === 0 ? [] : [`${counted(tally.edits, 'edit', 'edits')} (${namesOf(tally.edited)})`]),
    ...(tally.checks === 0 ? [] : [counted(tally.checks, 'test or build', 'tests or builds')]),
    ...(tally.research === 0 ? [] : [`${counted(tally.research, 'research lookup', 'research lookups')} (${namesOf(tally.researched)})`]),
    ...(searchNudgeAt > 0 && tally.searches >= searchNudgeAt ? [counted(tally.searches, 'code search', 'code searches')] : []),
  ];
  return parts.length === 0 ? undefined : `Lead boundary: this turn the lead did ${parts.join(', ')} itself; it delegates such work [leadBoundary].`;
}
