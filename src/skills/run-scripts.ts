import { posix, win32 } from 'node:path';
import type { Files } from '../core/files.ts';
import { errorCode } from '../core/guards.ts';
import { printable } from '../core/printable.ts';
import type { SkillScript } from './grants.ts';
import type { SkillFile } from './lint.ts';
import { SkillDir } from './store.ts';

/**
 * The scripts a skill runs beyond the files at the top of its folder (T1401). One kind is a script its SKILL.md runs
 * by an absolute or home path: the ship skill runs a checkout's `tools/ship/ship.ts`, and its folder holds SKILL.md
 * alone. The other is a module any of its scripts imports by a relative path. The grants check reads them all, so a
 * privileged call moved out of the folder, or into an imported module, is still seen. A path relative to a repo is
 * left out, since nothing says which repo the session runs it from.
 */

/**
 * At most this many scripts are followed for one skill, nearest first. A script that imports a whole program stays a
 * bounded read, and the scripts the skill runs come first, then each script's own imports.
 */
export const MAX_FOLLOWED = 200;

/**
 * At most this many paths are tried for one skill, found or not: an import may name up to 7 files (`importTargets`),
 * and scripts full of imports of files that are not there would otherwise try 7 for every import line they hold.
 */
export const MAX_TRIED = 1000;

/** How much of a followed file is read: a path a SKILL.md names may be any file, a device or a pipe (`readHead`). */
export const MAX_SCRIPT_BYTES = 1024 * 1024;

const EXTENSION = String.raw`\.(?:[cm]?[jt]s|sh|ps1|py)`;
/** Where a rooted path starts: a drive, the root, `~` or `$HOME`. */
const ROOT = String.raw`(?:[A-Za-z]:[\\/]|~[\\/]|\$\{?HOME\}?[\\/]|/)`;
/**
 * A rooted script path: between quotes or backticks (a space allowed), or bare after a space, `(` or `=` and before a
 * space, a quote or a shell separator. A URL's path never matches, as a `:` or a letter comes before its `/`.
 */
const SCRIPT_PATH = new RegExp(
  String.raw`(['"\x60])(${ROOT}[^'"\x60\n]*?${EXTENSION})\1|(?<![^\s(=])(${ROOT}[^\s'"\x60|;&<>()]*?${EXTENSION})(?![^\s'"\x60|;&)])`,
  'g',
);
/** A word before the path that runs it: an interpreter, PowerShell's call operator or `-File`. */
const RUNNER = /(?:^|[\s`'"(;|&])(?:node|tsx|bun|deno|bash|sh|zsh|pwsh|powershell|python3?|py)(?:\.exe)?[\s'"`]|(?:^|\s)&\s|\s-File\s/i;
/** Nothing before the path but a prompt or a call mark: the path is the command. */
const COMMAND_START = /^\s*(?:[$>&.]\s+)?['"`]?$/;
/** A module's relative imports: `import … from './x'`, `export … from`, `import './x'`, `import('./x')`, `require('./x')`. */
const RELATIVE_IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"`](\.{1,2}\/[^'"`\n]+)['"`]/g;
const JS_FILE = /\.[cm]?[jt]s$/;
const HOME_START = /^(?:~|\$\{?HOME\}?)\//;

function slashed(path: string): string {
  return path.replaceAll('\\', '/');
}

/**
 * The script paths a SKILL.md runs: each rooted script path on a line that runs it, made absolute (`~` and `$HOME`
 * are `home`). A UNC or device path (`//host/share`, `\\?\`) is never one: reading it would open the share, sending
 * the user's NTLM hash to whatever host the text names.
 */
export function runScriptPaths(text: string, home: string): string[] {
  const paths = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    for (const match of line.matchAll(SCRIPT_PATH)) {
      const raw = slashed(match[2] ?? match[3] ?? '');
      const before = line.slice(0, match.index);
      if (raw.startsWith('//') || !(RUNNER.test(before) || COMMAND_START.test(before))) {
        continue;
      }
      const fromHome = HOME_START.exec(raw);
      paths.add(posix.normalize(fromHome === null ? raw : `${slashed(home).replace(/\/+$/, '')}/${raw.slice(fromHome[0].length)}`));
    }
  }
  return [...paths];
}

/** The files a relative import may name, in the order node and TypeScript try them: a `.js` import is often a `.ts` file. */
function importTargets(from: string, spec: string): string[] {
  const path = posix.join(posix.dirname(from), slashed(spec));
  if (/\.[cm]?js$/.test(path)) {
    return [path, path.replace(/js$/, 'ts')];
  }
  if (JS_FILE.test(path)) {
    return [path];
  }
  return [...['.ts', '.mts', '.js', '.mjs', '.cjs'].map((extension) => `${path}${extension}`), `${path}/index.ts`, `${path}/index.js`];
}

/**
 * How the check names a followed script: by its path from the skill's folder, else from home, else whole, with its
 * control characters escaped, as a SKILL.md may name any path and the name goes into the check's flag line.
 */
function displayName(path: string, folder: string, home: string): string {
  const under = (root: string): string | null => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null);
  const inFolder = under(folder);
  if (inFolder !== null) {
    return printable(inFolder);
  }
  const inHome = under(slashed(home).replace(/\/+$/, ''));
  return printable(inHome === null ? path : `~/${inHome}`);
}

/**
 * The errors a path a SKILL.md names may give on any machine but its author's: a folder in the way, no access, a
 * name the OS refuses. Such a script is one the lint cannot read, as a missing one, and never fails the whole check.
 */
const UNREADABLE = new Set(['EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'ENAMETOOLONG', 'EINVAL', 'ELOOP']);

/**
 * `path` as the check may read it: slashes turned, `.` and `..` resolved, and absolute on a drive (`C:/`) or a single
 * root (`/`); undefined for any other. A UNC or device path (`//host/share`, `//?/UNC/`, `//./pipe/`) would open the
 * share, sending the user's NTLM hash to the host the text names, and an import with enough `..` and backslashes left
 * one (T1401's security review). A drive path whose `..` pops past its drive turns relative, and would read under the cwd.
 */
export function localPath(path: string): string | undefined {
  const turned = slashed(path);
  // Before normalising, which reads a leading `//` as one root and would read `//host/s` as the local `/host/s`.
  if (turned.startsWith('//')) {
    return undefined;
  }
  const normal = posix.normalize(turned);
  const absolute = /^(?:[A-Za-z]:\/|\/(?!\/))/.test(normal);
  return absolute && !/^[\\/]{2}/.test(win32.resolve(normal)) ? normal : undefined;
}

/** The head of the file at `path`, or undefined when it is no local path (`localPath`), missing or unreadable. */
async function readNamed(files: Files, path: string): Promise<string | undefined> {
  const local = localPath(path);
  if (local === undefined) {
    return undefined;
  }
  try {
    return await files.readHead(local, MAX_SCRIPT_BYTES);
  } catch (error) {
    const code = errorCode(error);
    if (code !== undefined && UNREADABLE.has(code)) {
      return undefined;
    }
    throw error;
  }
}

/** `skill` with the scripts its SKILL.md runs from outside `folder` and the modules its scripts import, read through `files`. */
export async function withRunScripts(files: Files, skill: SkillFile, folder: string, home: string): Promise<SkillFile> {
  const root = slashed(folder).replace(/\/+$/, '');
  const known = new Set<string>();
  const queue: (readonly string[])[] = [];
  const enqueue = (targets: readonly string[]): void => {
    if (targets.some((target) => known.has(target))) {
      return;
    }
    targets.forEach((target) => known.add(target));
    queue.push(targets);
  };
  const importsOf = (path: string, text: string): void => {
    if (JS_FILE.test(path)) {
      for (const match of text.matchAll(RELATIVE_IMPORT)) {
        enqueue(importTargets(path, match[1] ?? ''));
      }
    }
  };
  const own = skill.scripts.map((script) => ({ path: `${root}/${script.name}`, text: script.text }));
  own.forEach(({ path }) => known.add(path));
  runScriptPaths(skill.text, home).forEach((path) => enqueue([path]));
  own.forEach(({ path, text }) => importsOf(path, text));

  const followed: SkillScript[] = [];
  let tried = 0;
  for (let at = 0; at < queue.length && followed.length < MAX_FOLLOWED && tried < MAX_TRIED; at++) {
    for (const path of (queue[at] ?? []).slice(0, MAX_TRIED - tried)) {
      tried++;
      const text = await readNamed(files, path);
      if (text !== undefined) {
        followed.push({ name: displayName(path, root, home), text });
        importsOf(path, text);
        break;
      }
    }
  }
  return followed.length === 0 ? skill : { ...skill, scripts: [...skill.scripts, ...followed] };
}

/** Every skill in the skills folder `dir`, each with the scripts it runs from outside its folder and their imports, for the skills lint. */
export async function skillsToLint(files: Files, dir: string, home: string): Promise<SkillFile[]> {
  const skills = await new SkillDir(files, dir).readAll();
  return Promise.all(skills.map((skill) => withRunScripts(files, skill, posix.join(slashed(dir), skill.name), home)));
}
