import { Buffer } from 'node:buffer';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { programName, type ProgramLaunch } from './launchers.ts';
import type { ShellWord } from './tokenizer.ts';

/*
 * Interpreter scripts. A script a general-purpose interpreter runs (a python
 * heredoc, `node -e`, a perl file) is data to the shell: its text is not a shell command line, so the word `push`
 * in a message it posts never arms a doubt about the shell line (see `GitInvocationFinder`). Its text is judged here
 * instead, by a text rule meant to catch an ACCIDENTAL push by a cooperative agent that writes the push into a script.
 * It is no sandbox: a script that builds `'gi' + 't'` or decodes its command defeats any text rule, as it defeats the
 * shell guard's own reading. The rule asks for a push word AND a way to reach git (a process primitive, or a git
 * library), so a script that only talks about pushes (even `git push` in a message), or only runs `git status`, passes.
 */

/** The interpreters whose scripts are judged: python, node and the JS runtimes, perl, ruby, php. */
const INTERPRETER = /^(?:python[\d.]*|pypy[\d.]*|node|nodejs|deno|bun|perl[\d.]*|ruby[\d.]*|php[\d.]*)$/;

/** The language an interpreter's program name runs, or undefined when it is not one of {@link INTERPRETER}. */
export function interpreterOf(launched: ProgramLaunch): string | undefined {
  return launched.program.dynamic ? undefined : interpreterLanguage(programName(launched.program.text));
}

/** The language an interpreter's program name (as {@link programName} gives it) runs, or undefined. */
export function interpreterLanguage(name: string): string | undefined {
  if (!INTERPRETER.test(name)) {
    return undefined;
  }
  return /^(?:python|pypy)/.test(name)
    ? 'python'
    : /^(?:node|deno|bun)/.test(name)
      ? 'JavaScript'
      : name.replace(/[\d.]+$/, '');
}

/** A word that names git's push, but not a method call such as JavaScript's `list.push(x)`. */
const PUSH_WORD = /(?<![\w.-])(?:git-)?push(?![\w-])/i;
/** A push method call, as git libraries spell one (`origin.push()`, `remote.push(...)`). */
const PUSH_CALL = /\.push\s*\(/;
/** Libraries that run git in process, so no process primitive is needed. */
const GIT_LIBRARY = /(?<![\w-])(?:dulwich|pygit2|gitpython|from\s+git\s+import|import\s+git\b|simple-git|isomorphic-git|nodegit|rugged|git2)(?![\w-])/i;
/** Ways a script starts another program, which may be git or a shell that runs it. */
const PROCESS_PRIMITIVE = new RegExp(
  [
    // python
    String.raw`\bsubprocess\b`,
    String.raw`\bPopen\b`,
    String.raw`\bos\s*\.\s*(?:system|popen|exec\w*|spawn\w*|posix_spawn\w*|fork\w*)\b`,
    String.raw`\bpty\s*\.\s*spawn\b`,
    String.raw`\bcommands\s*\.\s*getoutput\b`,
    String.raw`\b(?:import|from)\s+(?:pexpect|plumbum|sh|invoke|fabric)\b`,
    // JavaScript runtimes
    String.raw`\bchild_process\b`,
    String.raw`\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(`,
    String.raw`\b(?:Deno\s*\.\s*(?:Command|run)|Bun\s*\.\s*(?:spawn|spawnSync|\$))`,
    String.raw`\$\s*\``,
    String.raw`\b(?:execa|shelljs|zx)\b`,
    // perl, ruby, php
    String.raw`\b(?:system|exec|readpipe|popen|proc_open|shell_exec|passthru|pcntl_exec)\s*[('"\[]`,
    String.raw`\bqx\s*\W`,
    String.raw`%x\s*\W`,
    String.raw`\bIPC::(?:Open[23]|Run)\b`,
    String.raw`\b(?:Open3|IO\s*\.\s*popen|Kernel\s*\.\s*(?:system|exec|spawn))\b`,
  ].join('|'),
);

/** True when a script of `language` may push: it names a push and has a way to reach git. */
export function scriptMayPush(text: string, language: string): boolean {
  const gitInProcess = GIT_LIBRARY.test(text);
  if (gitInProcess && PUSH_CALL.test(text)) {
    return true;
  }
  if (!PUSH_WORD.test(text)) {
    return false;
  }
  // Perl, ruby and php run a backticked command; in JavaScript a backtick is a template string, in python nothing.
  const backticks = (language === 'perl' || language === 'ruby' || language === 'php') && text.includes('`');
  // The word git alone runs nothing: a message that says "git push" passes unless the script can start a program.
  return gitInProcess || backticks || PROCESS_PRIMITIVE.test(text);
}

/** The most of a script file the guard reads; a longer one is judged by its start. */
const MAX_SCRIPT_BYTES = 256 * 1024;

/** Reads a script file a command names, or undefined when it is not a readable regular file. */
export function readScriptFile(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return undefined;
    }
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_SCRIPT_BYTES));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

/**
 * How each language's interpreter takes its program from its options: the short and long
 * options whose value is inline code (no script file follows), a module (likewise), the script file itself, a file
 * it loads before the script (a preload), or any other value (skipped), and the subcommand words that come
 * before the script under deno and bun (`deno run x.ts`). `programs` adds options only some programs of a language
 * take (deno's `-c` is its config file; to node, `-c` is `--check`, which takes no value).
 */
interface OptionTable {
  readonly code: readonly string[];
  readonly module: readonly string[];
  readonly file: readonly string[];
  readonly preload: readonly string[];
  readonly value: readonly string[];
  readonly subcommands: readonly string[];
  readonly programs?: Readonly<Record<string, readonly string[]>>;
}

const OPTIONS: Readonly<Record<string, OptionTable>> = {
  python: { code: ['-c'], module: ['-m'], file: [], preload: [], value: ['-W', '-X', '--check-hash-based-pycs'], subcommands: [] },
  JavaScript: {
    code: ['-e', '-p', '--eval', '--print'],
    module: [],
    file: [],
    preload: ['-r', '--require', '--import', '--loader', '--experimental-loader'],
    value: ['-C', '--conditions', '--input-type', '--env-file', '--env-file-if-exists', '--disable-warning', '--title', '--watch-path'],
    subcommands: ['run'],
    programs: { deno: ['-c', '--config', '--cert', '--lock', '--import-map', '-L', '--log-level'], bun: ['-c', '--config', '--cwd'] },
  },
  perl: { code: ['-e', '-E'], module: [], file: [], preload: [], value: ['-I', '-M', '-m', '-x'], subcommands: [] },
  ruby: { code: ['-e'], module: [], file: [], preload: ['-r'], value: ['-I', '-C', '-E'], subcommands: [] },
  php: { code: ['-r', '-B', '-R', '-E', '-F'], module: [], file: ['-f'], preload: [], value: ['-d', '-c', '-z', '-S', '-t'], subcommands: [] },
};

/** Python modules that run the script file named by their first argument (`python3 -m runpy push.py`). */
const SCRIPT_RUNNERS: ReadonlySet<string> = new Set(['runpy', 'pdb', 'cProfile', 'profile']);

/**
 * How an interpreter run reads its program from its arguments: `script`, the index of the argument it runs as its
 * script file (undefined when it runs inline code, a module or stdin), and `end`, the index of the last argument
 * that is still the interpreter's own (an option, its value, a preload, or the script). The arguments after `end`
 * are the script's own data, never its program.
 */
export interface ProgramArgs {
  readonly script: number | undefined;
  readonly end: number;
}

/**
 * Reads an interpreter run's arguments ({@link ProgramArgs}). Its options are skipped (with the value of one that
 * takes a value), and so is a subcommand word before the script; `python -m runpy x.py` runs `x.py`.
 */
export function programArgs(args: readonly ShellWord[], language: string, program = ''): ProgramArgs {
  const table = OPTIONS[language];
  if (table === undefined) {
    return { script: undefined, end: -1 };
  }
  // Only deno and bun take a subcommand before the script; to node, `run` is a script file.
  const subcommands = /^(?:deno|bun)$/.test(program) ? table.subcommands : [];
  const value = [...table.value, ...table.preload, ...(table.programs?.[program] ?? [])];
  const script = (index: number): ProgramArgs => (index < args.length ? { script: index, end: index } : { script: undefined, end: args.length - 1 });
  const none = (index: number): ProgramArgs => ({ script: undefined, end: index });
  let subcommandSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      return none(index);
    }
    const text = arg.text;
    if (arg.dynamic && text.startsWith('-')) {
      continue;
    }
    if (text === '--') {
      return script(index + 1);
    }
    if (text === '-') {
      return none(index); // the program comes from stdin
    }
    if (text.startsWith('--')) {
      const name = text.split('=', 1)[0] ?? text;
      if (table.code.includes(name)) {
        return none(index);
      }
      if (table.module.includes(name)) {
        return moduleRun(args, index + 1);
      }
      if (value.includes(name) && !text.includes('=')) {
        index += 1;
      }
      continue;
    }
    if (text.startsWith('-') && text.length > 1) {
      // A cluster of short options (`-EP`, `-Wignore`): the first one that takes a value ends it.
      for (let at = 1; at < text.length; at += 1) {
        const option = `-${text[at]}`;
        const attached = at + 1 < text.length;
        if (table.code.includes(option)) {
          return none(index);
        }
        if (table.module.includes(option)) {
          return attached ? moduleRun(args, index, text.slice(at + 1)) : moduleRun(args, index + 1);
        }
        if (table.file.includes(option)) {
          return attached ? none(index) : script(index + 1);
        }
        if (value.includes(option)) {
          if (!attached) {
            index += 1;
          }
          break;
        }
      }
      continue;
    }
    if (!subcommandSeen && subcommands.includes(text)) {
      subcommandSeen = true;
      continue;
    }
    return script(index);
  }
  return none(args.length - 1);
}

/**
 * A python `-m` run whose module name is at `at` (or attached, as in `-mrunpy`): a module that runs a script
 * file names it in its first argument that is not an option; any other module reads its arguments as data.
 */
function moduleRun(args: readonly ShellWord[], at: number, attached?: string): ProgramArgs {
  const name = attached ?? args[at]?.text;
  if (name === undefined || !SCRIPT_RUNNERS.has(name)) {
    return { script: undefined, end: Math.min(at, args.length - 1) };
  }
  const index = args.findIndex((arg, each) => each > at && !arg.text.startsWith('-'));
  return index === -1 ? { script: undefined, end: args.length - 1 } : { script: index, end: index };
}

/** The index of the argument an interpreter run reads as its script file; see {@link programArgs}. */
export function scriptArgIndex(args: readonly ShellWord[], language: string, program = ''): number | undefined {
  return programArgs(args, language, program).script;
}

/** The file an argument names, in `dir` when relative; undefined when it names none the guard can read as written. */
function argPath(arg: ShellWord | undefined, dir: string | undefined): string | undefined {
  if (arg === undefined || arg.dynamic || arg.text === '' || arg.text.includes('\n')) {
    return undefined;
  }
  return isAbsolute(arg.text) ? arg.text : dir === undefined ? undefined : join(dir, arg.text);
}

/**
 * The text an interpreter run takes as its program: every argument (inline `-c`/`-e`/`--eval` code, and the rest,
 * which only makes the rule stricter), the stdin a heredoc or here-string gives it, and each file among its own
 * arguments ({@link programArgs}: a preload such as `node -r ./x.js`, and the script) that is readable in `dir`.
 * The arguments after the script are its data: they are judged as written, never read as files (a transcript
 * that quotes `git push` is no program). When the script it names is not a readable file, as when an option the
 * guard does not know took the script's place, every readable argument that is no option is read instead. An
 * argument only known when it runs is read as written.
 */
export function interpreterText(
  launched: ProgramLaunch,
  stdin: ShellWord | undefined,
  dir: string | undefined,
  readScript: (path: string) => string | undefined,
  language: string,
): string {
  const parts = launched.args.map((arg) => arg.text);
  if (stdin !== undefined) {
    parts.push(stdin.text);
  }
  const read = (arg: ShellWord | undefined): string | undefined => {
    const path = argPath(arg, dir);
    return path === undefined ? undefined : readScript(path);
  };
  const own = programArgs(launched.args, language, programName(launched.program.text));
  const scriptArg = own.script === undefined ? undefined : launched.args[own.script];
  const unreadScript = scriptArg !== undefined && !scriptArg.dynamic && read(scriptArg) === undefined;
  launched.args.forEach((arg, index) => {
    const ownArg = index <= own.end;
    if ((ownArg || unreadScript) && !arg.text.startsWith('-')) {
      const body = read(arg);
      if (body !== undefined) {
        parts.push(body);
      }
    } else if (ownArg && arg.text.startsWith('--') && arg.text.includes('=')) {
      // A preload written `--require=./x.js`.
      const body = read({ ...arg, text: arg.text.slice(arg.text.indexOf('=') + 1) });
      if (body !== undefined) {
        parts.push(body);
      }
    }
  });
  return parts.join('\n');
}

/** The doubt a script that may push raises. */
export function interpreterDoubt(language: string): string {
  return `it runs a ${language} script that may run git push, whose push the guard cannot read; run the push as a plain git command on the line instead`;
}
