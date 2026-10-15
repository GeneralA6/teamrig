import { basename } from 'node:path';
import type { ToolUse } from '../budget/line.ts';
import { kindOf } from '../budget/patterns.ts';

/**
 * Work the lead hands off instead of doing (T320): an edit outside its own files, a test or a build, a
 * code search. Deciding, briefing and reading results, boards and docs are its job and are not counted.
 */
export type LeadWork = 'edit' | 'check' | 'search';

/** Where a shell step starts: a line's start or after `&&`, `;`, `||`, `(`, `$(` or a ` -- `, past a leading `cd`. */
const STEP = String.raw`(?:^|&&|;|\|\||\$?\(|\s--\s)\s*(?:cd\s+\S+\s*(?:&&|;)\s*)?`;
/** A git step that changes a repository. */
const GIT_WRITE = new RegExp(String.raw`${STEP}git\s+(?:-C\s+\S+\s+)?(?:commit|push|merge|rebase|cherry-pick|revert|reset|apply|am)\b`, 'm');
/** A shell search over files; a pipe into grep filters output and is not one. */
const SHELL_SEARCH = new RegExp(String.raw`${STEP}(?:grep|rg|find|Select-String|git\s+grep)\s`, 'm');
/** A source file: reading one is research. */
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|rb|php|sh|ps1|sql)$/i;
const SEARCH_TOOLS: ReadonlySet<string> = new Set(['Grep', 'Glob']);
/** The turn-end line names this many edited files, then counts the rest. */
const MAX_NAMES = 3;
const HAND_OFF =
  'The lead hands such work to the owning session (a register task), a helper or a temporary session, and keeps to deciding and briefing [leadBoundary].';

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
  private readonly home: string;
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

/** What one of the lead's calls did that it hands off; undefined for its own job. */
export function leadWorkOf(tool: ToolUse, own: OwnPaths): LeadWork | undefined {
  const command = tool.command ?? '';
  const kind = kindOf(tool);
  if (kind === 'edit' || kind === 'editTest' || GIT_WRITE.test(command)) {
    return (tool.path === undefined ? own.named(command) : own.owns(tool.path)) ? undefined : 'edit';
  }
  if (kind === 'testFull' || kind === 'testTargeted' || kind === 'build') {
    return 'check';
  }
  if (tool.name === 'Read') {
    return tool.path !== undefined && CODE_FILE.test(tool.path) && !own.owns(tool.path) ? 'search' : undefined;
  }
  if (SEARCH_TOOLS.has(tool.name)) {
    return tool.path !== undefined && own.owns(tool.path) ? undefined : 'search';
  }
  return SHELL_SEARCH.test(command) && !own.named(command) ? 'search' : undefined;
}

/** The lead's hand-off work in one turn. */
export interface LeadTally {
  readonly edits: number;
  /** The edited files' names in order, each once; `git` or `shell` for a step that names no file. */
  readonly edited: readonly string[];
  readonly checks: number;
  readonly searches: number;
}

function editName(tool: ToolUse): string {
  if (tool.path !== undefined) {
    return basename(tool.path.replace(/\\/g, '/'));
  }
  return GIT_WRITE.test(tool.command ?? '') ? 'git' : 'shell';
}

/** The hand-off work among a turn's calls. */
export function leadTallyOf(turn: readonly ToolUse[], own: OwnPaths): LeadTally {
  let edits = 0;
  let checks = 0;
  let searches = 0;
  const edited: string[] = [];
  for (const tool of turn) {
    switch (leadWorkOf(tool, own)) {
      case 'edit': {
        edits += 1;
        const name = editName(tool);
        if (!edited.includes(name)) {
          edited.push(name);
        }
        break;
      }
      case 'check':
        checks += 1;
        break;
      case 'search':
        searches += 1;
        break;
      case undefined:
        break;
    }
  }
  return { edits, edited, checks, searches };
}

/**
 * The line for the lead's model after `current`, once a turn per kind: at its first edit, its first
 * test or build, and its `searchNudgeAt`-th code search (0: never for searches). `turn` includes `current`.
 */
export function leadNudgeLine(turn: readonly ToolUse[], current: ToolUse, own: OwnPaths, searchNudgeAt: number): string | undefined {
  const tally = leadTallyOf(turn, own);
  switch (leadWorkOf(current, own)) {
    case 'edit':
      return tally.edits === 1 ? `teamrig: the lead edited ${editName(current)} itself. ${HAND_OFF}` : undefined;
    case 'check':
      return tally.checks === 1 ? `teamrig: the lead ran a test or a build itself. ${HAND_OFF}` : undefined;
    case 'search':
      return searchNudgeAt > 0 && tally.searches === searchNudgeAt ? `teamrig: the lead made ${searchNudgeAt} code searches itself this turn. ${HAND_OFF}` : undefined;
    case undefined:
      return undefined;
  }
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The owner's turn-end line when the lead did hand-off work itself; searches count from `searchNudgeAt` (0: never). */
export function leadStopLine(tally: LeadTally, searchNudgeAt: number): string | undefined {
  const more = tally.edited.length - MAX_NAMES;
  const names = tally.edited.slice(0, MAX_NAMES).join(', ') + (more > 0 ? ` +${more} more` : '');
  const parts = [
    ...(tally.edits === 0 ? [] : [`${counted(tally.edits, 'edit', 'edits')} (${names})`]),
    ...(tally.checks === 0 ? [] : [counted(tally.checks, 'test or build', 'tests or builds')]),
    ...(searchNudgeAt > 0 && tally.searches >= searchNudgeAt ? [counted(tally.searches, 'code search', 'code searches')] : []),
  ];
  return parts.length === 0 ? undefined : `Lead boundary: this turn the lead did ${parts.join(', ')} itself; it delegates such work [leadBoundary].`;
}
