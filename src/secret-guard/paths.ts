import * as nodePath from 'node:path';
import { bashDrivePath, resolveDir } from '../push-guard/location.ts';
import type { ShellDialect } from '../push-guard/tokenizer.ts';
import { characterClasses, GlobAutomaton, telltaleCharacters } from './glob-automaton.ts';
import { globNodes, globRegExp, hasWildcard, type GlobOptions } from './glob.ts';
import { holdsPublicKeysOnly, PEM_GLOB, PUBLIC_PEM_SUFFIX } from './public-key.ts';
import { fitsSecret, type WalkedGlob } from './secret-walk.ts';

/**
 * The files whose content is a secret, and how a word on a command line names one. A team's own globs come after
 * these, in order, and the last glob that matches a path decides, as in a `.gitignore`: `!glob` keeps a path readable.
 * Claude Code's own stores and the shells' histories are among them: a secret typed or allowed once stays in them.
 */
export const DEFAULT_SECRET_PATHS: readonly string[] = [
  '**/.env',
  '**/.env.*',
  '!**/.env.example',
  '!**/.env.sample',
  '~/.npmrc',
  '~/.ssh/**',
  '!~/.ssh/*.pub',
  '~/.aws/credentials',
  '**/.kube/config',
  '~/.docker/config.json',
  '**/.git-credentials',
  '~/.config/gh/hosts.yml',
  // gh's hosts file on Windows, under the roaming app data folder; the line above guarded nothing there (T2038).
  '~/AppData/Roaming/GitHub CLI/hosts.yml',
  '~/.claude/.credentials.json',
  '~/.claude/history.jsonl',
  '**/.claude/settings.local.json',
  '~/.bash_history',
  '~/.zsh_history',
  '**/PSReadLine/*_history.txt',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.jks',
  '**/*.keystore',
  '**/id_rsa',
  '**/id_ecdsa',
  '**/id_ed25519',
  // Terraform's state holds the secrets it creates in plain text.
  '**/*.tfstate',
  '**/*.tfstate.backup',
];

/** Stands for a part of a path only known when the line runs: it matches inside a `*` or `**`, never a name a glob spells out. */
const UNKNOWN = '\u0000';

/**
 * The most states `mayName` walks a word and the secret globs through before it counts the word as naming a secret,
 * the safe side. A word of a few wildcards next to the default globs walks a few hundred.
 */
const MAX_WALK_STATES = 20_000;

/** How a word with wildcards reads: `dotfiles` false for a bash word; `sets` as `SetReading` says. */
export type WordReading = Pick<GlobOptions, 'dotfiles' | 'sets'>;

interface CompiledGlob {
  /** The glob as the list spells it, `!` included. */
  readonly source: string;
  readonly keep: boolean;
  /** The glob anchored (`~/` at home, a relative one at any depth), as `pattern` and `automaton` read it. */
  readonly anchored: string;
  readonly pattern: RegExp;
  readonly automaton: GlobAutomaton;
  /**
   * True when a word whose last name is wildcards alone (`dir/*`) is tried against the glob: a secret folder
   * (`~/.ssh/**`), or a name spelled out in a folder spelled out (`~/.aws/credentials`) or starting with a dot
   * (`**\/.env`, which only wildcards that match dots reach). Never a name with wildcards (`*.pem`) or a plain name at
   * any depth (`id_rsa`), else every `grep x *` would name one it cannot see.
   */
  readonly wildcardAlone: boolean;
}

/** The secret files of a team: the defaults, then its own globs. */
export class SecretPaths {
  private readonly globs: readonly CompiledGlob[];
  private readonly ignoreCase: boolean;
  private readonly readKey: ((path: string) => string | undefined) | undefined;

  /**
   * `home` anchors `~/`; `ignoreCase` is true on hosts whose file names ignore case. `readKey` reads a `.pub.pem`
   * file's text for the public key check (#875); without it every `.pem` stays a secret, whatever it holds.
   */
  constructor(globs: readonly string[], home: string, ignoreCase: boolean, readKey?: (path: string) => string | undefined) {
    this.ignoreCase = ignoreCase;
    this.readKey = readKey;
    const anchor = normalisePath(home);
    this.globs = globs.map((glob) => compileGlob(glob, anchor, ignoreCase));
  }

  /** True when the file at `path`, an absolute path, holds a secret. */
  listed(path: string): boolean {
    return this.decideFile(path, normalisePath(path));
  }

  /**
   * True when a word naming `path` may name a secret file: the path itself is one, or, when it holds wildcards, some
   * path fits both them and a secret glob, and no later `!glob` keeps that path (`.env.l*` fits `.env.local`;
   * `b*.pem` fits `b.pem`), unless they only meet by coincidence (`fitsSecret`: `*.ts` and `.env.ts`). A last name
   * of wildcards alone (`dir/*`) is tried only against the globs that let it (see `CompiledGlob.wildcardAlone`), else
   * every `grep x *` would name a `*.pem` it cannot see.
   */
  mayName(path: string, reading: WordReading): boolean {
    const normal = normalisePath(path);
    if (!hasWildcard(normal, reading.sets)) {
      return this.decideFile(path, normal);
    }
    const word = new GlobAutomaton(globNodes(normal, { ...reading, ignoreCase: this.ignoreCase }), this.ignoreCase);
    const onlyWildcards = /^(?:[*?]|\[[^\]/]+\])+$/.test(normal.slice(normal.lastIndexOf('/') + 1));
    const walked = this.globs.map((glob): WalkedGlob => ({ ...glob, tried: !glob.keep && (!onlyWildcards || glob.wildcardAlone) }));
    const chars = telltaleCharacters([normal, ...this.globs.map(({ anchored }) => anchored)]);
    return fitsSecret(word, walked, characterClasses(chars, [word, ...this.globs.map(({ automaton }) => automaton)]), MAX_WALK_STATES);
  }

  /**
   * The globs' decision on one file, except that a `.pub.pem` file listed by `**\/*.pem` alone, no later glob of the
   * team's naming it, is no secret while its text holds public keys and nothing else (#875). The text is read here,
   * so a private key saved under that name, a file that cannot be read and a word with wildcards stay refused.
   */
  private decideFile(path: string, normal: string): boolean {
    const deciding = this.decidingGlob(normal);
    if (deciding === undefined || deciding.keep) {
      return false;
    }
    const name = this.ignoreCase ? normal.toLowerCase() : normal;
    if (this.readKey === undefined || deciding.source !== PEM_GLOB || !name.endsWith(PUBLIC_PEM_SUFFIX)) {
      return true;
    }
    const text = this.readKey(path);
    return text === undefined || !holdsPublicKeysOnly(text);
  }

  /** The last glob that matches `path`, which decides it, as in a `.gitignore`; undefined when none does. */
  private decidingGlob(path: string): CompiledGlob | undefined {
    let deciding: CompiledGlob | undefined;
    for (const glob of this.globs) {
      if (glob.pattern.test(path)) {
        deciding = glob;
      }
    }
    return deciding;
  }
}

/** `glob` anchored as the guard reads it: `~/` at home, an absolute glob where it says, any other at any depth. */
function compileGlob(glob: string, home: string, ignoreCase: boolean): CompiledGlob {
  const keep = glob.startsWith('!');
  const body = (keep ? glob.slice(1) : glob).replaceAll('\\', '/');
  const options: GlobOptions = { ignoreCase, dotfiles: true, sets: 'bash' };
  const anchored = body === '~' || body.startsWith('~/') ? `${escapeGlob(home)}${body.slice(1)}` : isAbsolute(body) ? body : `**/${body.replace(/^\*\*\//, '')}`;
  const last = anchored.slice(anchored.lastIndexOf('/') + 1);
  const folderSpelled = anchored
    .slice(0, anchored.lastIndexOf('/'))
    .split('/')
    .some((part) => part !== '' && !hasWildcard(part, 'bash'));
  return {
    source: glob,
    keep,
    anchored,
    pattern: globRegExp(anchored, options),
    automaton: new GlobAutomaton(globNodes(anchored, options), ignoreCase),
    wildcardAlone: last === '**' || (!hasWildcard(last, 'bash') && (folderSpelled || last.startsWith('.'))),
  };
}

function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path);
}

/** `text` with every glob character escaped, so a home folder named `a[1]` stays literal. */
function escapeGlob(text: string): string {
  return text.replace(/[*?[]/g, (char) => `[${char}]`);
}

/** `path` with forward slashes, `.` and `..` resolved, and no trailing slash. */
export function normalisePath(path: string): string {
  const slashed = path.replaceAll('\\', '/');
  const normal = nodePath.posix.normalize(slashed);
  return normal.length > 1 && normal.endsWith('/') && !/^[A-Za-z]:\/$/.test(normal) ? normal.slice(0, -1) : normal;
}

/** How the guard resolves a word to a path. */
export interface WordPlace {
  readonly dialect: ShellDialect;
  /** The folder the program runs in; undefined when it is only known when the line runs. */
  readonly dir: string | undefined;
  readonly home: string;
}

/** The variables that name the home folder, in each dialect's spelling. */
const HOME_VARIABLES: Readonly<Record<ShellDialect, RegExp>> = {
  bash: /\$(?:\{(?:HOME|USERPROFILE)\}|(?:HOME|USERPROFILE)\b)/g,
  powershell: /\$(?:\{env:(?:HOME|USERPROFILE)\}|env:(?:HOME|USERPROFILE)\b|HOME\b)/gi,
  cmd: /%(?:HOME|USERPROFILE)%/gi,
};
/** Any other variable or substitution, only known when the line runs. */
const OTHER_PARTS: Readonly<Record<ShellDialect, RegExp>> = {
  bash: /\$(?:\{[^}]*\}|\([^)]*\)|\w+)|`[^`]*`/g,
  powershell: /\$(?:\{[^}]*\}|\([^)]*\)|[\w:]+)/g,
  cmd: /%[^%]+%/g,
};

/**
 * The absolute path a word names, as far as the line tells: `~` and the home variables are the home folder, any other
 * variable is a part only known when it runs, a relative path starts in the program's folder (or one only known when
 * it runs), and Git Bash's `/c/x` is `C:/x` on Windows.
 */
export function wordPath(text: string, place: WordPlace): string {
  const expanded = text.replace(HOME_VARIABLES[place.dialect], () => place.home).replace(OTHER_PARTS[place.dialect], UNKNOWN);
  const native = place.dialect === 'bash' ? bashDrivePath(expanded, place.home) : expanded;
  return resolveDir(place.dir, native, place.home) ?? `${UNKNOWN}/${native}`;
}
