import { join } from 'node:path';
import { DEFAULT_TESTS } from '../../config/defaults.ts';
import { errorMessage } from '../../core/guards.ts';
import { ENV, resolveKitHome } from '../../core/home.ts';
import { resolveTeam } from '../../core/team.ts';
import { commandHeader, logBody, pruneLogs, reserveLog } from '../../test-run/logs.ts';
import { cleanOutput, parseTestOutput } from '../../test-run/parse.ts';
import { labelOf, reportLines } from '../../test-run/report.ts';
import { commandLine, type ShellResult } from '../../test-run/shell.ts';
import type { ParsedArgs } from '../args.ts';
import { sessionRef, shellWordsOf } from '../inputs.ts';
import { openKit, rosterOf, teamFolders } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';

/** Where a run's log goes, whose it is, and how much of its failures is printed. */
interface LogPlace {
  readonly dir: string;
  /** The session the log is named after, null for none. */
  readonly session: string | null;
  readonly maxFailureChars: number;
}

/** The session the run is for, as given: `--session`, else the session variable, else none. */
function givenSession(args: ParsedArgs, runtime: CliRuntime): string | null {
  const flag = args.flags.get('session');
  if (flag !== undefined) {
    return sessionRef('--session', flag);
  }
  const fromEnv = runtime.env[ENV.session]?.trim();
  return fromEnv === undefined || fromEnv === '' ? null : sessionRef(`$${ENV.session}`, fromEnv);
}

/**
 * In a team, its logs folder and config, with the session named by its id when the roster knows the
 * name; a name it does not know still names the log. Outside a team (or with a broken pointer), the
 * kit home's logs folder and the default cap, so the command works in any folder.
 */
async function logPlace(runtime: CliRuntime, session: string | null): Promise<LogPlace> {
  const found = await resolveTeam(runtime.files, runtime.env, teamFolders(runtime.env, [runtime.cwd]));
  if (found.kind !== 'team') {
    return { dir: join(resolveKitHome(runtime.env, runtime.userHome), 'logs'), session, maxFailureChars: DEFAULT_TESTS.maxFailureChars };
  }
  const kit = await openKit(runtime, found.team);
  if (kit.load.status !== 'loaded') {
    return { dir: kit.paths.logs, session, maxFailureChars: DEFAULT_TESTS.maxFailureChars };
  }
  const { config } = kit.load;
  const known = session === null ? undefined : (await rosterOf(runtime, kit, config)).lookup(session);
  return { dir: kit.paths.logs, session: known?.ok === true ? known.id : session, maxFailureChars: config.tests.maxFailureChars };
}

/** Runs the command; when it cannot start, the log (holding the command line) says why before the error goes on. */
async function runLogged(runtime: CliRuntime, command: string, log: string): Promise<ShellResult> {
  try {
    return await runtime.shell.run({ command, cwd: runtime.cwd, env: runtime.env });
  } catch (error) {
    await runtime.files.append(log, `could not start: ${errorMessage(error)}\n`);
    throw error;
  }
}

/**
 * `teamrig test -- <command ...>`: runs a test command in the shell, writes all it printed to a
 * numbered log (the session's newest 20 are kept) and prints one PASS or FAIL line, then each failing
 * test within `tests.maxFailureChars`, so a long test run costs the model a few lines. Exit 0 when the
 * command passed, 1 otherwise.
 */
export async function test(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const words = shellWordsOf(args, runtime.platform);
  const place = await logPlace(runtime, givenSession(args, runtime));
  const command = commandLine(words, runtime.platform);
  const log = await reserveLog(runtime.files, place.dir, place.session, commandHeader(command));
  const started = runtime.clock.now();
  const result = await runLogged(runtime, command, log);
  const tookMs = runtime.clock.now() - started;
  const output = cleanOutput(result.output);
  await runtime.files.append(log, logBody(output, result.end));
  await pruneLogs(runtime.files, place.dir, place.session);
  const lines = reportLines({ label: labelOf(words), end: result.end, tookMs, log, output, parsed: parseTestOutput(output), maxFailureChars: place.maxFailureChars });
  for (const line of lines) {
    runtime.out.stdout(line);
  }
  return result.end.kind === 'exited' && result.end.code === 0 ? EXIT.ok : EXIT.failed;
}
