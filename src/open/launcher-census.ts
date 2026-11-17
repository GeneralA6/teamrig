import { win32 } from 'node:path';
import type { ListedProcess } from './session-processes.ts';

/** Why a launcher counts as orphaned: its starter is gone, or the id it names now belongs to a later process. */
export type OrphanReason = 'starter-gone' | 'starter-reused';

/** One `teamrig launch` process: the root of a session's terminal tab, which runs and restarts its Claude Code. */
export interface Launcher {
  readonly pid: number;
  /** The session it launches, from `launch <id>`. */
  readonly session: string;
  /** Its team, from `--team`; undefined when the command line names none. */
  readonly team: string | undefined;
  /** When it started, in milliseconds since 1970; undefined where the system does not say (a `ps` listing). */
  readonly startedMs: number | undefined;
  readonly parentPid: number;
  /** The program of the process now holding `parentPid`; undefined when none is listed. */
  readonly parentName: string | undefined;
  readonly commandLine: string;
  /** Set when its tab is gone: the terminal that started it has ended, so nothing will ever end it. */
  readonly orphaned: OrphanReason | undefined;
}

export interface LauncherCensus {
  readonly launchers: readonly Launcher[];
  readonly orphaned: number;
}

const NODE_PROGRAM = /^node(\.exe)?$/i;
/**
 * The CLI's entry script, as `open` names it in a tab's command line (`runtime.self.script`). Its word is read with
 * the win32 path rules, which split both `\` and `/`: a Windows command line must match on a POSIX host too.
 */
const CLI_SCRIPT = /^main\.[cm]?js$/i;

/** A command line's words, quotes dropped: the system shows a Windows command line as one string. */
function wordsOf(commandLine: string): readonly string[] {
  return (commandLine.match(/"[^"]*"|\S+/g) ?? []).map((word) => word.replace(/^"(.*)"$/, '$1'));
}

/** The session and team a `node <main.js> launch <id> --team <team> ...` command line runs; undefined for another one. */
export function launchOf(name: string, commandLine: string): { readonly session: string; readonly team: string | undefined } | undefined {
  if (!NODE_PROGRAM.test(name)) {
    return undefined;
  }
  const words = wordsOf(commandLine);
  const script = words.findIndex((word, i) => CLI_SCRIPT.test(win32.basename(word)) && words[i + 1] === 'launch');
  const session = script < 0 ? undefined : words[script + 2];
  if (session === undefined || session.startsWith('-')) {
    return undefined;
  }
  const team = words.indexOf('--team', script + 3);
  return { session, team: team < 0 ? undefined : words[team + 1] };
}

/**
 * Every launcher in `listed`, each orphaned when the process that started it is no longer listed, or the listed
 * holder of its starter's id started after it (Windows reuses ids; an unknown start never counts as reused). A
 * launcher in `keep` (the caller's own lineage) is never orphaned: the census must not offer to end its own tab.
 */
export function launcherCensus(listed: readonly ListedProcess[], keep: ReadonlySet<number> = new Set()): LauncherCensus {
  const byPid = new Map(listed.map((entry) => [entry.info.pid, entry]));
  const launchers = listed.flatMap((entry): Launcher[] => {
    const launch = launchOf(entry.info.name, entry.info.commandLine);
    if (launch === undefined) {
      return [];
    }
    const starter = byPid.get(entry.info.parentPid);
    const reused = starter?.startedMs !== undefined && entry.startedMs !== undefined && starter.startedMs > entry.startedMs;
    const orphaned = keep.has(entry.info.pid) ? undefined : starter === undefined ? 'starter-gone' : reused ? 'starter-reused' : undefined;
    return [
      {
        pid: entry.info.pid,
        session: launch.session,
        team: launch.team,
        startedMs: entry.startedMs,
        parentPid: entry.info.parentPid,
        parentName: starter?.info.name,
        commandLine: entry.info.commandLine,
        orphaned,
      },
    ];
  });
  return { launchers, orphaned: launchers.filter((launcher) => launcher.orphaned !== undefined).length };
}
