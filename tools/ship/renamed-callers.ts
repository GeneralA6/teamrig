import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfigText } from '../../src/config/text.ts';
import { type Env, claudeConfigDir, resolveKitHome } from '../../src/core/home.ts';
import { teamPlace } from '../../src/delivery/places.ts';
import { slugOf } from './repos.ts';

/**
 * The renamed-callers gate of `ship.ts merge` (T1651): a change that renames a teamrig command is refused while a
 * consumer still calls only the old name, since teamrig refuses an old name with no alias and the caller then fails
 * (0.243.0 renamed `teamrig heavy` to `teamrig queue` and broke the git hooks of every repo that called it).
 *
 * A command is newly renamed when the tip's `src/cli/renamed.ts` maps it and main's does not, or maps it elsewhere.
 * Consumers are read on this machine: the tracked files and git hooks of each team's delivery repo checkout (but the
 * repo shipped, whose own callers the change moves), the Claude Code skills folder and each project's memory. A file
 * that names `teamrig <old>` and never `teamrig <new>` is a caller; naming both is a moved one with a fallback.
 */

/** The file the renamed commands live in, read here as text at main and at the tip. */
export const RENAMED_FILE = 'src/cli/renamed.ts';

export type RenamedRead = { ok: true; commands: Map<string, string> } | { ok: false; reason: string };

const COMMANDS_OPEN = /^\s*commands: \{$/;
const COMMANDS_CLOSE = /^\s*\},?$/;
const COMMAND_ENTRY = /^\s*'?([a-z][a-z0-9-]*)'?: '([a-z][a-z0-9-]*)',?$/;

/** The `commands` block of renamed.ts's text, old name to new; any line that is not `old: 'new',` is refused, never guessed. */
export function parseRenamedCommands(text: string): RenamedRead {
  const lines = text.split(/\r?\n/);
  const open = lines.findIndex(line => COMMANDS_OPEN.test(line));
  if (open === -1) return { ok: false, reason: `${RENAMED_FILE} has no "commands: {" line` };
  const commands = new Map<string, string>();
  for (let index = open + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (COMMANDS_CLOSE.test(line)) return { ok: true, commands };
    if (line.trim() === '') continue;
    const entry = COMMAND_ENTRY.exec(line);
    if (entry === null || entry[1] === undefined || entry[2] === undefined) {
      return { ok: false, reason: `line ${index + 1} of ${RENAMED_FILE} is not "old: 'new',": ${line.trim()}` };
    }
    commands.set(entry[1], entry[2]);
  }
  return { ok: false, reason: `${RENAMED_FILE} never closes its "commands: {" block` };
}

/** The tip's renames that main lacks, or maps to another name. */
export function newlyRenamed(base: ReadonlyMap<string, string>, tip: ReadonlyMap<string, string>): Map<string, string> {
  return new Map([...tip].filter(([old, renamed]) => base.get(old) !== renamed));
}

export interface Entry {
  name: string;
  folder: boolean;
}

export interface GrepHit {
  /** Relative to the checkout. */
  path: string;
  line: number;
  text: string;
}

/** What the gate reaches outside itself, so a test can stand in for each. */
export interface RenamedCallersDeps {
  /** A file's text, or null when it cannot be read. */
  readText: (path: string) => string | null;
  /** A folder's entries, empty when it cannot be read. */
  list: (dir: string) => Entry[];
  /** `git grep -E` over a checkout's tracked files; empty for no match, null when git fails. */
  gitGrep: (checkout: string, pattern: string) => GrepHit[] | null;
  /** A checkout's origin remote URL, or null when it has none. */
  originOf: (checkout: string) => string | null;
  /** A file's text at a revision of the repo shipped, or null when that revision lacks it. */
  gitShow: (rev: string, file: string) => string | null;
  log: (line: string) => void;
}

export interface RenamedCallersRequest {
  /** main as fetched (`refs/remotes/origin/<main>`) and the sha merged. */
  base: string;
  tip: string;
  /** The GitHub slug of the repo shipped: its own checkouts are not scanned. */
  repo: string;
  kitHome: string;
  /** Claude Code's own folder (`claudeConfigDir`): its skills folder and each project's memory folder are read. */
  claudeDir: string;
}

export interface Caller {
  path: string;
  line: number;
  old: string;
  renamed: string;
}

export type CallersScan = { kind: 'none' } | { kind: 'callers'; renames: Map<string, string>; callers: Caller[] } | { kind: 'unreadable'; reason: string };

const SKILL_TEXT = new Set(['md', 'ts', 'mts', 'cts', 'js', 'mjs', 'cjs', 'sh', 'ps1', 'cmd', 'json', 'txt', 'yml', 'yaml']);

const callRegex = (command: string): RegExp => new RegExp(`(?<![\\w-])teamrig ${command}(?![\\w-])`);

/** The callers in one file's lines: each line naming an old name, unless the file also names its new one. */
function callersIn(path: string, lines: readonly { line: number; text: string }[], renames: ReadonlyMap<string, string>): Caller[] {
  const callers: Caller[] = [];
  for (const [old, renamed] of renames) {
    const calls = callRegex(old);
    const moved = callRegex(renamed);
    if (lines.some(({ text }) => moved.test(text))) continue;
    for (const { line, text } of lines) if (calls.test(text)) callers.push({ path, line, old, renamed });
  }
  return callers;
}

const linesOf = (text: string): { line: number; text: string }[] => text.split(/\r?\n/).map((line, index) => ({ line: index + 1, text: line }));

/** Each team's delivery repo checkouts, but the repo shipped; a team config that does not parse is logged and skipped. */
function consumerCheckouts(request: RenamedCallersRequest, deps: RenamedCallersDeps): string[] {
  const checkouts = new Set<string>();
  const teams = join(request.kitHome, 'teams');
  for (const team of deps.list(teams).filter(entry => entry.folder)) {
    const home = join(teams, team.name);
    const text = deps.readText(join(home, 'config.json'));
    if (text === null) continue;
    const read = parseConfigText(text);
    if (read.status === 'unreadable') {
      deps.log(`renamed callers: ${team.name}'s config does not parse (${read.issue.message}): its repos are not scanned`);
      continue;
    }
    for (const repo of Object.values(read.config.delivery.repos)) checkouts.add(teamPlace({ home }, repo.mainCheckout));
  }
  const shipped = request.repo.toLowerCase();
  return [...checkouts].filter(checkout => {
    const origin = deps.originOf(checkout);
    return origin === null || slugOrNull(origin)?.toLowerCase() !== shipped;
  });
}

function slugOrNull(remote: string): string | null {
  try {
    return slugOf(remote);
  } catch {
    return null;
  }
}

/** A checkout's callers: its tracked files as checked out (what its hooks run) and its own git hooks. */
function checkoutCallers(checkout: string, renames: ReadonlyMap<string, string>, deps: RenamedCallersDeps): Caller[] {
  const names = [...new Set([...renames.keys(), ...renames.values()])];
  const hits = deps.gitGrep(checkout, `teamrig (${names.join('|')})`);
  if (hits === null) {
    deps.log(`renamed callers: git grep failed in ${checkout}: its files are not scanned`);
    return [];
  }
  const byFile = new Map<string, { line: number; text: string }[]>();
  for (const hit of hits) byFile.set(hit.path, [...(byFile.get(hit.path) ?? []), { line: hit.line, text: hit.text }]);
  const tracked = [...byFile].flatMap(([path, lines]) => callersIn(join(checkout, path), lines, renames));
  const hooks = join(checkout, '.git', 'hooks');
  const hookFiles = deps.list(hooks).filter(entry => !entry.folder && !entry.name.endsWith('.sample'));
  return [...tracked, ...hookFiles.flatMap(entry => fileCallers(join(hooks, entry.name), renames, deps))];
}

function fileCallers(path: string, renames: ReadonlyMap<string, string>, deps: RenamedCallersDeps): Caller[] {
  const text = deps.readText(path);
  return text === null ? [] : callersIn(path, linesOf(text), renames);
}

/** The text files under a folder, but in `node_modules` and dot folders. */
function textFilesUnder(root: string, deps: RenamedCallersDeps): string[] {
  const files: string[] = [];
  const folders = [root];
  for (let folder = folders.pop(); folder !== undefined; folder = folders.pop()) {
    for (const entry of deps.list(folder)) {
      if (entry.folder) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') folders.push(join(folder, entry.name));
      } else if (SKILL_TEXT.has(entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase())) {
        files.push(join(folder, entry.name));
      }
    }
  }
  return files.sort();
}

/** Each project's memory files under Claude Code's folder. */
function memoryFiles(claudeDir: string, deps: RenamedCallersDeps): string[] {
  const projects = join(claudeDir, 'projects');
  return deps
    .list(projects)
    .filter(entry => entry.folder)
    .flatMap(project => {
      const memory = join(projects, project.name, 'memory');
      return deps
        .list(memory)
        .filter(entry => !entry.folder && entry.name.endsWith('.md'))
        .map(entry => join(memory, entry.name));
    });
}

/** The renames `request` brings, then every consumer file still calling only an old name. */
export function scanRenamedCallers(request: RenamedCallersRequest, deps: RenamedCallersDeps): CallersScan {
  const tipText = deps.gitShow(request.tip, RENAMED_FILE);
  if (tipText === null) return { kind: 'none' };
  const tip = parseRenamedCommands(tipText);
  if (!tip.ok) return { kind: 'unreadable', reason: `${tip.reason} at ${request.tip.slice(0, 7)}` };
  const baseText = deps.gitShow(request.base, RENAMED_FILE);
  if (baseText === null) {
    deps.log(`renamed callers: ${request.base} has no ${RENAMED_FILE}, so no command counts as newly renamed`);
    return { kind: 'none' };
  }
  const base = parseRenamedCommands(baseText);
  if (!base.ok) return { kind: 'unreadable', reason: `${base.reason} at ${request.base}` };
  const renames = newlyRenamed(base.commands, tip.commands);
  if (renames.size === 0) return { kind: 'none' };
  deps.log(`renamed callers: this change renames ${[...renames].map(([old, renamed]) => `${old} to ${renamed}`).join(', ')}; reading consumer checkouts, skills and memory`);
  const files = [...textFilesUnder(join(request.claudeDir, 'skills'), deps), ...memoryFiles(request.claudeDir, deps)];
  const callers = [
    ...consumerCheckouts(request, deps).flatMap(checkout => checkoutCallers(checkout, renames, deps)),
    ...files.flatMap(path => fileCallers(path, renames, deps)),
  ];
  return callers.length === 0 ? { kind: 'none' } : { kind: 'callers', renames, callers };
}

/** The refusal a scan gives, or null when the merge may go on. */
export function refusalOf(scan: CallersScan, limit = 40): string | null {
  if (scan.kind === 'none') return null;
  if (scan.kind === 'unreadable') return `the renamed-callers gate cannot read the renamed commands: ${scan.reason}; keep "commands: {" with one "old: 'new'," per line`;
  const called = [...scan.renames].filter(([old]) => scan.callers.some(caller => caller.old === old));
  const files = new Set(scan.callers.map(caller => caller.path)).size;
  const lines = scan.callers.slice(0, limit).map(caller => `  ${caller.path}:${caller.line} teamrig ${caller.old} -> ${caller.renamed}`);
  if (scan.callers.length > limit) lines.push(`  ... and ${scan.callers.length - limit} more`);
  const renames = called.map(([old, renamed]) => `teamrig ${old} to ${renamed}`).join(', ');
  return [`this change renames ${renames} while ${files} consumer file(s) still call only the old name: move them (or name both) and merge again`, ...lines].join('\n');
}

/** `git grep -n -z` output: path, NUL, line number, NUL, the line. */
export function parseGrep(output: string): GrepHit[] {
  return output.split('\n').flatMap(row => {
    const [path, line, ...text] = row.split('\0');
    if (path === undefined || line === undefined || !/^\d+$/.test(line)) return [];
    return [{ path, line: Number(line), text: text.join('\0') }];
  });
}

const exitStatus = (error: unknown): number | null =>
  typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : null;

const gitText = (args: readonly string[]): string | null => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
};

/** The real files and git, for the repo shipped in `dir`. */
export function realRenamedCallersDeps(dir: string, log: (line: string) => void): RenamedCallersDeps {
  return {
    readText: path => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    list: folder => {
      try {
        return readdirSync(folder, { withFileTypes: true }).map(entry => ({ name: entry.name, folder: entry.isDirectory() }));
      } catch {
        return [];
      }
    },
    gitGrep: (checkout, pattern) => {
      try {
        return parseGrep(execFileSync('git', ['-C', checkout, 'grep', '-n', '-z', '-I', '-E', pattern, '--'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }));
      } catch (error) {
        // git grep exits 1 when nothing matches.
        return exitStatus(error) === 1 ? [] : null;
      }
    },
    originOf: checkout => gitText(['-C', checkout, 'remote', 'get-url', 'origin'])?.trim() ?? null,
    gitShow: (rev, file) => gitText(['-C', dir, 'show', `${rev}:${file}`]),
    log,
  };
}

/** The change `ship.ts merge` asks about: main as fetched, the sha merged and the repo's GitHub slug. */
export interface RenamedChange {
  base: string;
  tip: string;
  repo: string;
}

/** Where consumers live: the kit home and Claude Code's folder, found from these as every teamrig command finds them. */
export interface ConsumerHome {
  env: Env;
  userHome: string;
}

/** The gate as `ship.ts merge` runs it: the refusal, or null when no consumer calls only a newly renamed command. */
export function renamedCallersRefusal(change: RenamedChange, home: ConsumerHome, deps: RenamedCallersDeps): string | null {
  const kitHome = resolveKitHome(home.env, home.userHome);
  return refusalOf(scanRenamedCallers({ ...change, kitHome, claudeDir: claudeConfigDir(home.env, home.userHome) }, deps));
}
