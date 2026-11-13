import { basename } from 'node:path';

/** A command line's words, as the system shows it (spaces) or as it was given (NULs). */
function argsOf(commandLine: string): readonly string[] {
  return commandLine.split(/[\s\0]+/).filter((arg) => arg !== '');
}

/** Whether `commandLine` is a fork (`--fork-session`) resumed from Claude Code session `claudeSession` or its transcript file. */
export function isForkOf(commandLine: string | undefined, claudeSession: string): boolean {
  if (commandLine === undefined) {
    return false;
  }
  const args = argsOf(commandLine);
  if (!args.includes('--fork-session')) {
    return false;
  }
  return args.some((arg, i) => {
    const value = arg.startsWith('--resume=') ? arg.slice('--resume='.length) : i > 0 && (args[i - 1] === '--resume' || args[i - 1] === '-r') ? arg : undefined;
    return value !== undefined && (value === claudeSession || basename(value).replace(/\.jsonl$/, '') === claudeSession);
  });
}

/** How many of a background job's starters are looked through for its host: the host starts the job itself. */
export const BACKGROUND_HOST_HOPS = 2;

/** The value of `--session-id` in `args` (`--session-id <id>` or `--session-id=<id>`); undefined when it names none. */
function sessionIdOf(args: readonly string[]): string | undefined {
  for (const [i, arg] of args.entries()) {
    if (arg.startsWith('--session-id=')) {
      return arg.slice('--session-id='.length) || undefined;
    }
    if (arg === '--session-id') {
      return args[i + 1];
    }
  }
  return undefined;
}

/**
 * The Claude Code session a background job runs as, from its `lineage` (the job's process first, then its starters):
 * one of its first `BACKGROUND_HOST_HOPS` starters is Claude Code's background host (`claude bg-pty-host --bg-pty-host
 * <socket> <columns> <rows> -- <the job's command>`), and the host's command, else the job's own, names the session
 * with `--session-id`. The host's comes first: it is not the process that runs the job's turns and /clear. Undefined for
 * a process no background host runs, or a job that names no session.
 */
export function backgroundJobSessionOf(lineage: readonly { readonly commandLine: string }[]): string | undefined {
  const [job, ...starters] = lineage;
  const host = starters.slice(0, BACKGROUND_HOST_HOPS).find((starter) => argsOf(starter.commandLine).includes('--bg-pty-host'));
  if (job === undefined || host === undefined) {
    return undefined;
  }
  return sessionIdOf(argsOf(host.commandLine)) ?? sessionIdOf(argsOf(job.commandLine));
}
