import { Buffer } from 'node:buffer';
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, posix, relative } from 'node:path';
import { reviewPathMatcher } from './review-paths.ts';
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

/** The interpreters whose scripts are judged: python (and Windows' py launcher), node and the JS runtimes, perl, ruby, php. */
const INTERPRETER = /^(?:python[\d.]*|pypy[\d.]*|py|node|nodejs|deno|bun|perl[\d.]*|ruby[\d.]*|php[\d.]*)$/;

/** The language an interpreter's program name runs, or undefined when it is not one of {@link INTERPRETER}. */
export function interpreterOf(launched: ProgramLaunch): string | undefined {
  if (launched.program.dynamic) {
    return undefined;
  }
  const name = programName(launched.program.text);
  if (!INTERPRETER.test(name)) {
    return undefined;
  }
  return /^(?:python|pypy|py$)/.test(name)
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
    String.raw`\bcreate_subprocess_(?:shell|exec)\b`,
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
    // perl's piped open: a mode of -| or |- (open($fh, '-|', 'git', 'push')), or a command line that ends or starts
    // with a pipe (open(FH, "git push origin main |")); ruby's open("|git push")
    String.raw`\bopen\s*\(?\s*[^,;()]+,\s*['"](?:-\||\|-)['"]`,
    String.raw`\bopen\s*\(?\s*[^,;()]+,\s*['"](?:\s*\|[^'"]*|[^'"]*\|\s*)['"]`,
    String.raw`\bopen\s*\(?\s*['"]\s*\|`,
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

/** All the script files one command line's interpreters read, together: a line naming many big files reads no more. */
export const MAX_LINE_SCRIPT_BYTES = 1024 * 1024;

/** Windows' reserved device names, which name a device in any folder and with any extension (`nul.txt`). */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;

/**
 * True for a path no script file is read from: a UNC or Windows device path (`\\server\share`, `//server/share`,
 * `\\.\pipe\x`, `\\?\C:\x`), a Windows reserved device name, or a POSIX device or kernel file (`/dev`, `/proc`,
 * `/sys`). Reading one may block, reach the network, or never end.
 */
export function isDevicePath(path: string): boolean {
  if (/^[\\/]{2}/.test(path)) {
    return true;
  }
  if (/^\/(?:dev|proc|sys)(?:\/|$)/.test(path)) {
    return true;
  }
  return WINDOWS_DEVICE.test(basename(path.replaceAll('\\', '/')));
}

/**
 * Reads up to `maxBytes` (at most {@link MAX_SCRIPT_BYTES}) of a script file a command names, or undefined when it is
 * not a regular file. It never blocks: a device or UNC path is skipped (`isDevicePath`), the path is stat'ed before it
 * is opened, so a FIFO, socket or device is never opened, and the file is opened non-blocking where the platform has
 * that, then checked again to be the same regular file.
 */
export function readScriptFile(path: string, maxBytes: number = MAX_SCRIPT_BYTES): string | undefined {
  if (maxBytes <= 0 || isDevicePath(path)) {
    return undefined;
  }
  let fd: number | undefined;
  try {
    const before = statSync(path);
    if (!before.isFile()) {
      return undefined;
    }
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev) {
      return undefined;
    }
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_SCRIPT_BYTES, maxBytes));
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
 * Whether a script file path is one of the team's trusted scripts (`pushGuard.trustedScripts`): a glob with no slash
 * names a file at any depth, one with a slash is read from `cwd` (the session's folder), and an absolute one from the
 * root; case is ignored, as in the review gate's globs (`reviewPathMatcher`). A path outside `cwd` matches only a glob
 * with no slash or an absolute one.
 */
export function trustedScriptMatcher(globs: readonly string[], cwd: string): (path: string) => boolean {
  const slashed = (path: string): string => path.replace(/\\/g, '/');
  const matchers = globs.map((glob) => ({ kind: isAbsolute(glob) || /^[A-Za-z]:[\\/]/.test(glob) ? 'absolute' : glob.includes('/') ? 'rooted' : 'name', matches: reviewPathMatcher(slashed(glob)) }));
  return (path) => {
    const whole = slashed(path).replace(/^\/+/, '');
    const fromCwd = slashed(relative(cwd, path));
    const inside = fromCwd !== '' && fromCwd !== '..' && !fromCwd.startsWith('../') && !isAbsolute(fromCwd) && !/^[A-Za-z]:/.test(fromCwd);
    return matchers.some(({ kind, matches }) => (kind === 'rooted' ? inside && matches(fromCwd) : matches(whole)));
  };
}

/** What is left of a command line's {@link MAX_LINE_SCRIPT_BYTES}, shared by every interpreter on it. */
export interface ScriptBudget {
  left: number;
}

/**
 * The text an interpreter run takes as its program: every argument (inline `-c`/`-e`/`--eval` code, and the rest,
 * which only makes the rule stricter), the stdin a heredoc or here-string gives it, and any argument that names a
 * readable file in `dir`, together no more than `budget` bytes for the line. An argument only known when it runs is read
 * as written. A test run ({@link isTestRun}) reads no file it names as a test ({@link isTestPath}): a test runs git in
 * the repositories it makes, and that is no push of the caller's.
 */
export function interpreterText(
  launched: ProgramLaunch,
  stdin: ShellWord | undefined,
  dir: string | undefined,
  readScript: (path: string, maxBytes: number) => string | undefined,
  budget: ScriptBudget = { left: MAX_LINE_SCRIPT_BYTES },
): string {
  const parts = launched.args.map((arg) => arg.text);
  if (stdin !== undefined) {
    parts.push(stdin.text);
  }
  const testRun = isTestRun(launched);
  for (const arg of launched.args) {
    if (arg.dynamic || arg.text === '' || arg.text.startsWith('-') || arg.text.includes('\n')) {
      continue;
    }
    if (testRun && isTestPath(arg.text)) {
      continue;
    }
    const path = isAbsolute(arg.text) ? arg.text : dir === undefined ? undefined : join(dir, arg.text);
    const body = path === undefined || budget.left <= 0 ? undefined : readScript(path, budget.left);
    if (body !== undefined) {
      budget.left -= Buffer.byteLength(body, 'utf8');
      parts.push(body);
    }
  }
  return parts.join('\n');
}

/**
 * True when an interpreter run is a test run, which runs each file it names as a test: node with `--test`, or deno or
 * bun whose first argument that is no option is `test`. A preload (`--import x.js`) and any file not named as a test
 * are still read.
 */
export function isTestRun(launched: ProgramLaunch): boolean {
  if (launched.program.dynamic) {
    return false;
  }
  const name = programName(launched.program.text);
  if (/^(?:node|nodejs)$/.test(name)) {
    return launched.args.some((arg) => !arg.dynamic && arg.text === '--test');
  }
  const first = launched.args.find((arg) => arg.dynamic || !arg.text.startsWith('-'));
  return /^(?:deno|bun)$/.test(name) && first !== undefined && !first.dynamic && first.text === 'test';
}

/**
 * A path (or a glob) a test runner reads as a test file, by node's own default patterns (`*.test.js`, `*-test.js`,
 * `*_test.js`, `test-*.js`, `test.js`, and any file in a `test` folder), with `.spec` and a `tests` or `__tests__`
 * folder too, in any JavaScript or TypeScript extension. The path is read with its `.` and `..` segments resolved.
 */
export function isTestPath(path: string): boolean {
  if (!/\.[cm]?[jt]sx?$/.test(path)) {
    return false;
  }
  // `test/../push.js` is push.js: judge the path its `.` and `..` segments lead to, never the words as written.
  const parts = posix.normalize(path.replaceAll('\\', '/')).split('/');
  const name = parts.at(-1) ?? '';
  return /^(?:.+[.\-_](?:test|spec)|test-.+|test|spec)\.[cm]?[jt]sx?$/.test(name) || parts.slice(0, -1).some((part) => /^(?:test|tests|__tests__)$/.test(part));
}

/** The doubt a script that may push raises. */
export function interpreterDoubt(language: string): string {
  return `it runs a ${language} script that may run git push, whose push the guard cannot read; run the push as a plain git command on the line instead`;
}
