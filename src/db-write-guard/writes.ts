import type { DbProgramShape, DbWriteGuardConfig, DbWriteProgram } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import { programsOf, type ProgramRun, type ProgramsContext } from '../package-guard/programs.ts';
import { programName } from '../push-guard/launchers.ts';
import { resolveDir } from '../push-guard/location.ts';
import type { ShellWord } from '../push-guard/tokenizer.ts';
import { remoteLineOf, skipOptions } from '../secret-guard/remote.ts';
import { clientWritesIn, documentShellWritesIn, isKeyValueWrite, keyValueCommandWritesIn, luaWritesIn, sqlWritesIn } from './verbs.ts';

/** The team's rules the scan reads: its entrypoints, database programs, Node clients and client words. */
export type DbWriteRules = Omit<DbWriteGuardConfig, 'writes'>;

export interface DbWriteContext extends ProgramsContext {
  readonly files: Files;
  readonly rules: DbWriteRules;
}

/** A write a command line makes to a database by hand. */
export interface DbWrite {
  /** The program that makes it, as the line names it: `psql`, `docsh`, `node scripts/fix.cjs`. */
  readonly program: string;
  /** What writes: the methods, commands or statements (`deleteMany`, `FLUSHALL`, `DROP`), or an entrypoint's apply flags. */
  readonly writes: readonly string[];
  /** True for an entrypoint run with an apply flag. */
  readonly entrypoint: boolean;
  /** True when it runs in a container or on a remote host. */
  readonly elsewhere: boolean;
}

/** One write as a phrase: "psql runs DROP", "node scripts/backfill.ts runs with --apply". */
export function describeDbWrite(write: DbWrite): string {
  const what = write.entrypoint ? `runs with ${write.writes.join(', ')}` : `runs ${write.writes.join(', ')}`;
  return `${write.program} ${what}${write.elsewhere ? ' in a container or on a remote host' : ''}`;
}

type ReadText = (path: string) => Promise<string | undefined>;

/** How a line is read: where its files come from, whether it runs elsewhere, and the input a remote call hands it. */
interface Scan {
  readonly readText: ReadText;
  readonly elsewhere: boolean;
  /** What the host hands the remote line on stdin: `kubectl exec -i p -- psql < fix.sql`. */
  readonly inherited: readonly string[];
}

/** The program a call starts and its words, after a package runner such as `npx tsx` is read. */
interface Call {
  readonly name: string;
  readonly args: readonly ShellWord[];
}

type Write = (program: string, writes: readonly string[], entrypoint?: boolean) => DbWrite[];

/**
 * The SQL clients the guard knows whatever the team sets. A store named by its product (a document shell, a
 * key-value client) is the team's to add in `dbWriteGuard.programs`, read before these.
 */
const BUILT_IN_PROGRAMS: readonly DbWriteProgram[] = [
  { name: 'psql', reads: 'sql-command' },
  { name: 'mysql', reads: 'sql-execute' },
  { name: 'mariadb', reads: 'sql-execute' },
  { name: 'sqlite3', reads: 'sql-database-file' },
];

const NODE_RUNTIMES: ReadonlySet<string> = new Set(['node', 'tsx', 'ts-node']);
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(['npx', 'pnpx']);
const ECHOES: ReadonlySet<string> = new Set(['echo', 'printf', 'write-output']);
const FILE_PRINTERS: ReadonlySet<string> = new Set(['cat', 'type', 'get-content', 'gc']);

/** A file name's extension: a document shell runs a word ending in one as a script (`fix.js`), when it is no option or address. */
const FILE_EXTENSION = /\.[A-Za-z0-9]+$/;

/** npx options that take the next word as their value. */
const RUNNER_VALUED: ReadonlySet<string> = new Set(['-p', '--package', '-c', '--call', '-w', '--workspace']);

/** Options of node, tsx and ts-node that take the next word as their value. */
const NODE_VALUED: ReadonlySet<string> = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type', '--title',
  '--env-file', '--tsconfig', '-P', '--project', '-O', '--compiler-options', '--compiler', '--cwd',
]);
/** Options of node, tsx and ts-node whose next word is code to run. */
const NODE_CODE: ReadonlySet<string> = new Set(['-e', '--eval', '-p', '--print']);
/** Options that make node, tsx or ts-node run no script: a test run, a syntax check, its version or help. */
const NODE_NO_SCRIPT: ReadonlySet<string> = new Set(['--test', '--check', '-c', '--version', '-v', '--help', '-h']);

/** Options of a key-value command-line client that take the next word as their value: its host, port, auth, TLS files. */
const KEY_VALUE_CLI_VALUED: ReadonlySet<string> = new Set([
  '-h', '-p', '-s', '-a', '-u', '-n', '-r', '-i', '-d', '-D', '-t', '--user', '--pass', '--askpass', '--cacert',
  '--cacertdir', '--cert', '--key', '--sni', '--tls-ciphers', '--tls-ciphersuites', '--pattern', '--count',
  '--quoted-pattern', '--memkeys-samples', '--rdb', '--functions-rdb', '--replica', '--pipe-timeout', '--cluster',
]);

/** sqlite3 options that take the next word as their value. */
const SQLITE_VALUED: ReadonlySet<string> = new Set([
  '-cmd', '-init', '-separator', '-newline', '-nullvalue', '-vfs', '-mmap', '-maxsize', '-lookaside', '-pagecache',
  '-heap', '-escape',
]);

/**
 * The writes a command line makes to a database by hand: SQL a client runs, the code a team's database program
 * runs, and Node code that writes through a client the team names and the code loads, here or in a container or on
 * a remote host. Code is read from the line, from the files it names and from what it pipes or redirects in; a file
 * the guard cannot read, and code only known when the line runs, raise no doubt.
 */
export async function dbWritesOf(command: string, context: DbWriteContext): Promise<DbWrite[]> {
  return writesOfLine(command, context, { readText: (path) => readLocal(context.files, path), elsewhere: false, inherited: [] });
}

/**
 * How much of a file a line names is read for its writes. A script or a SQL file is far smaller, while a dump fed to
 * a client (`psql app < dump.sql`) can be gigabytes, which the hook would hold in memory past its timeout. A write
 * further into a file is missed.
 */
const READ_LIMIT_BYTES = 1024 * 1024;

/** Two leading separators: a network share (`\\host\share`) or a Windows device path, which opening reaches before the human answers. */
const NETWORK_PATH = /^[\\/]{2}/;

/**
 * The first MiB of a file the host holds; undefined for a path on a network share, for no regular file (a pipe, a
 * device, a folder) and for a file it cannot read, which raises no doubt.
 */
async function readLocal(files: Files, path: string): Promise<string | undefined> {
  if (NETWORK_PATH.test(path)) {
    return undefined;
  }
  try {
    return await files.readHead(path, READ_LIMIT_BYTES);
  } catch {
    return undefined;
  }
}

async function writesOfLine(command: string, context: DbWriteContext, scan: Scan): Promise<DbWrite[]> {
  const runs = programsOf(command, context);
  const found: DbWrite[] = [];
  for (const run of runs) {
    found.push(...(await writesOfRun(run, runs, context, scan)));
  }
  return found;
}

async function writesOfRun(run: ProgramRun, runs: readonly ProgramRun[], context: DbWriteContext, scan: Scan): Promise<DbWrite[]> {
  const own = await inputOf(run, runs, (dir, path) => readAt(dir, path, context.home, scan.readText));
  const input = own.length > 0 || run.piped ? own : scan.inherited;
  const remote = remoteLineOf(run);
  if (remote !== undefined) {
    // The remote side's files are not the host's, and its folder is unknown.
    const elsewhere: Scan = { readText: async () => undefined, elsewhere: true, inherited: input };
    return writesOfLine(remote.line, { ...context, cwd: undefined, dialect: remote.dialect }, elsewhere);
  }
  const call = unwrapRunner({ name: run.name, args: run.args });
  const read = (path: string): Promise<string | undefined> => readAt(run.dir, path, context.home, scan.readText);
  const write: Write = (program, writes, entrypoint = false) =>
    writes.length === 0 ? [] : [{ program, writes, entrypoint, elsewhere: scan.elsewhere }];
  const shape = shapeOf(call.name, context.rules.programs);
  if (shape !== undefined) {
    return write(call.name, unique(await programWrites(shape, call.args.map((arg) => arg.text), input, read)));
  }
  if (NODE_RUNTIMES.has(call.name)) {
    return nodeWrites(call, input, read, context.rules, write);
  }
  return [];
}

/** How a program takes its code: the team's own entry first, so a team can read a built-in name its own way. */
function shapeOf(name: string, programs: readonly DbWriteProgram[]): DbProgramShape | undefined {
  return [...programs, ...BUILT_IN_PROGRAMS].find((program) => programName(program.name) === name)?.reads;
}

/** The writes a database program makes, read from its words, the files they name and its input, by its shape. */
async function programWrites(
  shape: DbProgramShape,
  texts: readonly string[],
  input: readonly string[],
  read: (path: string) => Promise<string | undefined>,
): Promise<string[]> {
  switch (shape) {
    case 'document-shell': {
      const files = [...optionValues(texts, ['-f', '--file']), ...texts.filter(isScriptWord)];
      const code = [...optionValues(texts, ['--eval']), ...(await readAll(files, read)), ...input];
      return code.flatMap(documentShellWritesIn);
    }
    case 'key-value-cli':
      return keyValueWrites(texts, input, read);
    case 'sql-command': {
      const sql = [...optionValues(texts, ['-c', '--command']), ...(await readAll(optionValues(texts, ['-f', '--file']), read)), ...input];
      return sql.flatMap(sqlWritesIn);
    }
    case 'sql-execute':
      return [...optionValues(texts, ['-e', '--execute']), ...input].flatMap(sqlWritesIn);
    case 'sql-database-file': {
      const database = skipOptions(texts, 0, SQLITE_VALUED);
      return [...texts.slice(database + 1), ...optionValues(texts, ['-cmd']), ...input].flatMap(sqlWritesIn);
    }
  }
}

/** True for a word a document shell runs as a script file: no option, no address such as `scheme://host`, a file extension. */
function isScriptWord(text: string): boolean {
  return !text.startsWith('-') && !text.includes('://') && FILE_EXTENSION.test(text);
}

/** What a call reads on stdin, as far as the line shows it: a here-document, a file it redirects in, or what pipes to it. */
async function inputOf(
  run: ProgramRun,
  runs: readonly ProgramRun[],
  readIn: (dir: string | undefined, path: string) => Promise<string | undefined>,
): Promise<string[]> {
  const texts: string[] = run.stdin === undefined ? [] : [run.stdin.text];
  for (const redirection of run.redirections) {
    if (/^0?<$/.test(redirection.operator) && redirection.target !== undefined && !redirection.target.dynamic) {
      texts.push(...(await readAll([redirection.target.text], (path) => readIn(run.dir, path))));
    }
  }
  for (const source of runs.filter((other) => other.pipe?.into === run)) {
    const words = source.args.filter((arg) => !arg.dynamic).map((arg) => arg.text);
    if (ECHOES.has(source.name)) {
      // printf and `echo -e` turn a written `\n` into a line break, so `printf 'GET a\nDEL b'` pipes two commands.
      texts.push(words.filter((word) => !/^-[a-z]+$/i.test(word)).join(' ').replace(/\\n/g, '\n'));
    } else if (FILE_PRINTERS.has(source.name)) {
      texts.push(...(await readAll(words.filter((word) => !word.startsWith('-')), (path) => readIn(source.dir, path))));
    }
  }
  return texts;
}

/** The text of a file a call names, read from where the call runs; undefined when that folder is unknown or it cannot be read. */
async function readAt(dir: string | undefined, path: string, home: string, readText: ReadText): Promise<string | undefined> {
  const resolved = resolveDir(dir, path, home);
  return resolved === undefined ? undefined : readText(resolved);
}

async function readAll(paths: readonly string[], read: (path: string) => Promise<string | undefined>): Promise<string[]> {
  const texts: string[] = [];
  for (const path of paths) {
    const text = await read(path);
    if (text !== undefined) {
      texts.push(text);
    }
  }
  return texts;
}

/** The program a package runner starts (`npx tsx fix.ts`, `npx -y tsx fix.ts`), or the call itself. */
function unwrapRunner(call: Call): Call {
  if (!PACKAGE_RUNNERS.has(call.name)) {
    return call;
  }
  const at = skipOptions(call.args.map((arg) => arg.text), 0, RUNNER_VALUED);
  const program = call.args[at];
  return program === undefined || program.dynamic ? call : { name: programName(program.text), args: call.args.slice(at + 1) };
}

/** The writes a key-value client makes: the command it runs, a Lua script it evaluates, or the commands it reads on stdin. */
async function keyValueWrites(texts: readonly string[], input: readonly string[], read: (path: string) => Promise<string | undefined>): Promise<string[]> {
  const scripts = optionValues(texts, ['--eval']);
  if (scripts.length > 0) {
    // `--eval trim.lua key , arg`: the words after the script are its keys and arguments, never a command.
    return (await readAll(scripts, read)).flatMap(luaWritesIn);
  }
  const at = skipOptions(texts, 0, KEY_VALUE_CLI_VALUED);
  const command = texts[at];
  if (command === undefined) {
    return input.flatMap(keyValueCommandWritesIn);
  }
  if (command.toUpperCase() === 'EVAL') {
    return luaWritesIn(texts[at + 1] ?? '');
  }
  return isKeyValueWrite(command) ? [command.toUpperCase()] : [];
}

/**
 * The writes node, tsx or ts-node makes: those of code it evaluates, or of the script it runs. An entrypoint writes
 * only with one of its apply flags among the script's words, whatever the script holds.
 */
async function nodeWrites(
  call: Call,
  input: readonly string[],
  read: (path: string) => Promise<string | undefined>,
  rules: DbWriteRules,
  write: Write,
): Promise<DbWrite[]> {
  const fromInput = (): DbWrite[] => write(call.name, unique(input.flatMap((code) => clientWritesIn(code, rules))));
  const texts = call.args.map((arg) => arg.text);
  for (let index = 0; index < texts.length; index += 1) {
    const text = texts[index] ?? '';
    if (NODE_NO_SCRIPT.has(text)) {
      return [];
    }
    const code = NODE_CODE.has(text) ? texts[index + 1] : /^--(?:eval|print)=(.*)$/s.exec(text)?.[1];
    if (code !== undefined) {
      return write(`${call.name} ${text.split('=')[0] ?? text}`, clientWritesIn(code, rules));
    }
    if (NODE_VALUED.has(text)) {
      index += 1;
    } else if (text === '-') {
      return fromInput();
    } else if (!text.startsWith('-')) {
      return scriptWrites(call, index, read, rules, write);
    }
  }
  return fromInput();
}

async function scriptWrites(
  call: Call,
  at: number,
  read: (path: string) => Promise<string | undefined>,
  rules: DbWriteRules,
  write: Write,
): Promise<DbWrite[]> {
  const script = call.args[at];
  if (script === undefined || script.dynamic) {
    return [];
  }
  const program = `${call.name} ${script.text}`;
  const entrypoint = rules.entrypoints.find((candidate) => endsWithPath(script.text, candidate.path));
  if (entrypoint !== undefined) {
    const words = call.args.slice(at + 1).map((arg) => arg.text);
    const flags = entrypoint.applyFlags.filter((flag) => words.some((word) => word === flag || word.startsWith(`${flag}=`)));
    return write(program, flags, true);
  }
  const text = await read(script.text);
  return text === undefined ? [] : write(program, clientWritesIn(text, rules));
}

/** True when `path` is `suffix` or ends with it as whole folders: `./scripts/fix.ts` and `/w/scripts/fix.ts` end with `scripts/fix.ts`. */
function endsWithPath(path: string, suffix: string): boolean {
  const normal = (text: string): string => text.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  const full = normal(path);
  const end = normal(suffix);
  return end !== '' && (full === end || full.endsWith(`/${end}`));
}

/** The values of the options in `names`: `--eval X`, `--eval=X`, and a short option's joined `-cX`. */
function optionValues(texts: readonly string[], names: readonly string[]): string[] {
  const values: string[] = [];
  texts.forEach((text, index) => {
    for (const name of names) {
      const next = texts[index + 1];
      if (text === name && next !== undefined) {
        values.push(next);
      } else if (name.startsWith('--') ? text.startsWith(`${name}=`) : text.startsWith(name) && text.length > name.length && name.length === 2) {
        values.push(text.slice(name.length + (name.startsWith('--') ? 1 : 0)));
      }
    }
  });
  return values;
}

function unique(names: readonly string[]): string[] {
  return [...new Set(names)];
}
