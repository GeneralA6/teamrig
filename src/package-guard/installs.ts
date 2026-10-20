import { staticWord } from '../push-guard/launchers.ts';
import type { ShellWord } from '../push-guard/tokenizer.ts';
import { programsOf, type ProgramsContext } from './programs.ts';
import { BUN_VALUED, FILE_PATH, NPM_VALUED, PNPM_VALUED, subcommandOf, YARN_VALUED } from './runners.ts';

/**
 * The package installs in a command line, as the install guard reads them: `npm install`, `pnpm add`, `yarn add`,
 * `bun add`, a global install, and their updates. An install from the lockfile alone (`npm ci`, a bare `npm install`,
 * `yarn`) or of a local folder names nothing to vet and is not one. A habit guard, not a security boundary, as the
 * ad-hoc guard is: a line built at run time (`eval "$X"`) or an install started by another program is not seen.
 */

/** What an install asks the registry for: an exact version, or the version a dist-tag points at. */
export type Wanted = { readonly kind: 'version'; readonly version: string } | { readonly kind: 'tag'; readonly tag: string };

/** One package an install names. */
export type InstallTarget =
  /** A registry package at an exact version or a dist-tag, which the guard vets against the registry. */
  | { readonly kind: 'registry'; readonly spec: string; readonly name: string; readonly wanted: Wanted }
  /** A package the guard cannot vet, with why. */
  | { readonly kind: 'unvetted'; readonly spec: string; readonly why: string };

/** One install a line runs: how it shows in a refusal (`npm install`), and the packages it names. */
export interface InstallCall {
  readonly call: string;
  readonly targets: readonly InstallTarget[];
}

/** How a word only known when the line runs shows in a refusal. */
const DYNAMIC_TEXT = '<a value only known when it runs>';
/** A word only known when the line runs, for an option whose value is missing. */
const UNKNOWN_WORD: ShellWord = { text: '', dynamic: true };

/** npm's install subcommands, with the misspellings npm takes for them. */
const NPM_INSTALLS: ReadonlySet<string> = new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add', 'it', 'install-test']);
const NPM_UPDATES: ReadonlySet<string> = new Set(['update', 'up', 'upgrade', 'udpate']);
/** npm install's options that take a value, so the word after one is not a package. */
const NPM_INSTALL_VALUED: ReadonlySet<string> = new Set([...NPM_VALUED, '--tag', '--omit', '--include', '--install-strategy', '--save-prefix', '--before', '--otp', '--cpu', '--os', '--libc', '--location']);
const PNPM_INSTALL_VALUED: ReadonlySet<string> = new Set([...PNPM_VALUED, '--reporter', '--loglevel', '--registry', '--store-dir', '--virtual-store-dir', '--modules-dir', '--workspace-concurrency', '--allow-build']);
const YARN_INSTALL_VALUED: ReadonlySet<string> = new Set([...YARN_VALUED, '--mode', '--modules-folder', '--cache-folder', '--registry', '--network-timeout']);
const BUN_INSTALL_VALUED: ReadonlySet<string> = new Set([...BUN_VALUED, '--registry', '--cache-dir', '--backend', '--omit', '--filter', '-F', '--cpu', '--os', '--linker']);

/** A spec of a local folder, file or workspace package, which the registry has no part in. */
const LOCAL_SPEC = /^(?:file|link|workspace|portal):|\.(?:tgz|tar|tar\.gz)$/i;
/** A spec fetched from git or a URL rather than the registry. */
const REMOTE_SPEC = /^(?:git\+|git:|github:|gitlab:|bitbucket:|gist:|https?:)|:\/\//i;
/** A registry name, a scope first or not; any case, as old packages have upper case. */
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
/** An exact version, with the `v` or `=` and the build npm drops: `1.2.3`, `v1.2.3-rc.1`, `=1.2.3+build`. */
const EXACT_VERSION = /^[v=]*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[0-9A-Za-z.-]+)?$/;
/** A dist-tag (`latest`, `next`), not a word npm reads as a range (`x`, `v1`). */
const DIST_TAG = /^(?![xX]$)(?![vV]\d)[A-Za-z][\w.-]*$/;

/** How an install reads a bare name: the tag it means (undefined when only known when the line runs), and whether `--before` picks by date. */
interface Reading {
  readonly tag: string | undefined;
  readonly byDate: boolean;
}

const LATEST: Reading = { tag: 'latest', byDate: false };

function unvetted(spec: string, why: string): InstallTarget {
  return { kind: 'unvetted', spec, why };
}

/** A spec's package name and what follows its `@`: `@scope/x@^1` is `@scope/x` and `^1`. */
function splitSpec(text: string): { readonly name: string; readonly range: string } {
  const at = text.indexOf('@', text.startsWith('@') ? 1 : 0);
  return at === -1 ? { name: text, range: '' } : { name: text.slice(0, at), range: text.slice(at + 1) };
}

/** What a registry spec asks for, or why it cannot be vetted. */
function registryTarget(spec: string, name: string, range: string, reading: Reading): InstallTarget {
  if (range === '' || DIST_TAG.test(range)) {
    const tag = range === '' ? reading.tag : range;
    if (tag === undefined) {
      return unvetted(spec, 'its tag is only known when the line runs');
    }
    return reading.byDate ? unvetted(spec, '--before picks its version by date, not by its tag') : { kind: 'registry', spec, name, wanted: { kind: 'tag', tag } };
  }
  const exact = EXACT_VERSION.exec(range)?.[1];
  return exact === undefined ? unvetted(spec, 'a range, not an exact version') : { kind: 'registry', spec, name, wanted: { kind: 'version', version: exact } };
}

/** The package a spec names, undefined for a local folder or file, or why it cannot be vetted. */
function targetOf(word: ShellWord, reading: Reading): InstallTarget | undefined {
  if (word.dynamic) {
    return unvetted(DYNAMIC_TEXT, 'a package only known when the line runs');
  }
  const spec = word.text;
  // Remote first: a URL's tarball (`https://host/x.tgz`) ends as a local file's does.
  if (REMOTE_SPEC.test(spec)) {
    return unvetted(spec, 'a git or URL source, not a registry version');
  }
  if (FILE_PATH.test(spec) || LOCAL_SPEC.test(spec)) {
    return undefined;
  }
  const { name, range } = splitSpec(spec);
  if (!name.startsWith('@') && name.includes('/')) {
    return unvetted(spec, 'a GitHub repository, not a registry version');
  }
  if (!PACKAGE_NAME.test(name)) {
    return unvetted(spec, 'not a package name');
  }
  if (range.startsWith('npm:')) {
    const aliased = targetOf(staticWord(range.slice('npm:'.length)), reading);
    return aliased === undefined ? undefined : { ...aliased, spec };
  }
  if (REMOTE_SPEC.test(range)) {
    return unvetted(spec, 'a git or URL source, not a registry version');
  }
  if (LOCAL_SPEC.test(range)) {
    return undefined;
  }
  if (range.includes('/')) {
    return unvetted(spec, 'a GitHub repository, not a registry version');
  }
  return registryTarget(spec, name, range, reading);
}

/** An install's package words and options, read anywhere among them: `--` ends the options and a valued option takes the next word. */
interface InstallWords {
  readonly specs: readonly ShellWord[];
  readonly values: ReadonlyMap<string, ShellWord>;
}

function installWordsOf(args: readonly ShellWord[], valued: ReadonlySet<string>): InstallWords {
  const specs: ShellWord[] = [];
  const values = new Map<string, ShellWord>();
  let options = true;
  let index = 0;
  while (index < args.length) {
    const word = args[index] ?? UNKNOWN_WORD;
    index += 1;
    if (!options || word.dynamic || !word.text.startsWith('-') || word.text === '-') {
      specs.push(word);
    } else if (word.text === '--') {
      options = false;
    } else {
      const equals = word.text.startsWith('--') ? word.text.indexOf('=') : -1;
      const name = equals === -1 ? word.text : word.text.slice(0, equals);
      if (equals !== -1) {
        values.set(name, staticWord(word.text.slice(equals + 1)));
      } else if (valued.has(name)) {
        values.set(name, args[index] ?? UNKNOWN_WORD);
        index += 1;
      }
    }
  }
  return { specs, values };
}

/** An install that adds what it names; a bare one installs from the lockfile and is not one. `npm` reads `--tag` and `--before`. */
function addCall(call: string, args: readonly ShellWord[], valued: ReadonlySet<string>, npm: boolean): InstallCall | undefined {
  const { specs, values } = installWordsOf(args, valued);
  const tag = npm ? values.get('--tag') : undefined;
  const reading: Reading = { tag: tag === undefined ? 'latest' : tag.dynamic ? undefined : tag.text, byDate: npm && values.has('--before') };
  const targets = specs.map((word) => targetOf(word, reading)).filter((target) => target !== undefined);
  return targets.length === 0 ? undefined : { call, targets };
}

/**
 * An update: a bare name moves to the newest version its range in package.json allows, and no name moves every
 * dependency, so neither names a version to vet. A name with a version is read as an add, except by npm, which reads
 * only names.
 */
function updateCall(call: string, args: readonly ShellWord[], valued: ReadonlySet<string>, readsVersions: boolean): InstallCall {
  const { specs } = installWordsOf(args, valued);
  if (specs.length === 0) {
    return { call, targets: [unvetted(call, 'moves every dependency to the newest version its range allows')] };
  }
  const floats = 'moves to the newest version its range allows';
  const targets = specs.map((word) => {
    if (word.dynamic || !readsVersions || splitSpec(word.text).range === '') {
      return unvetted(word.dynamic ? DYNAMIC_TEXT : word.text, floats);
    }
    return targetOf(word, LATEST);
  });
  return { call, targets: targets.filter((target) => target !== undefined) };
}

function npmInstall(args: readonly ShellWord[]): InstallCall | undefined {
  const { name, rest } = subcommandOf(args, NPM_VALUED);
  if (name !== undefined && NPM_INSTALLS.has(name)) {
    return addCall(`npm ${name}`, rest, NPM_INSTALL_VALUED, true);
  }
  return name !== undefined && NPM_UPDATES.has(name) ? updateCall(`npm ${name}`, rest, NPM_INSTALL_VALUED, false) : undefined;
}

function pnpmInstall(args: readonly ShellWord[]): InstallCall | undefined {
  const { name, rest } = subcommandOf(args, PNPM_VALUED);
  switch (name) {
    case 'add':
    case 'install':
    case 'i':
      return addCall(`pnpm ${name}`, rest, PNPM_INSTALL_VALUED, false);
    case 'update':
    case 'up':
    case 'upgrade':
      return updateCall(`pnpm ${name}`, rest, PNPM_INSTALL_VALUED, true);
    default:
      return undefined;
  }
}

function yarnInstall(args: readonly ShellWord[]): InstallCall | undefined {
  const { name, rest } = subcommandOf(args, YARN_VALUED);
  switch (name) {
    case 'add':
      return addCall('yarn add', rest, YARN_INSTALL_VALUED, false);
    case 'global': {
      const global = subcommandOf(rest, YARN_INSTALL_VALUED);
      return global.name === 'add' ? addCall('yarn global add', global.rest, YARN_INSTALL_VALUED, false) : undefined;
    }
    case 'upgrade':
    case 'up':
    case 'upgrade-interactive':
      return updateCall(`yarn ${name}`, rest, YARN_INSTALL_VALUED, true);
    default:
      return undefined;
  }
}

function bunInstall(args: readonly ShellWord[]): InstallCall | undefined {
  const { name, rest } = subcommandOf(args, BUN_VALUED);
  switch (name) {
    case 'add':
    case 'a':
    case 'install':
    case 'i':
      return addCall(`bun ${name}`, rest, BUN_INSTALL_VALUED, false);
    case 'update':
      return updateCall('bun update', rest, BUN_INSTALL_VALUED, true);
    default:
      return undefined;
  }
}

/** Each package manager by program name. */
const MANAGERS: ReadonlyMap<string, (args: readonly ShellWord[]) => InstallCall | undefined> = new Map([
  ['npm', npmInstall],
  ['pnpm', pnpmInstall],
  ['yarn', yarnInstall],
  ['bun', bunInstall],
]);

/** The installs `command` runs that name a package; see {@link InstallCall}. */
export function installCallsOf(command: string, context: ProgramsContext): InstallCall[] {
  return programsOf(command, context).flatMap((run) => MANAGERS.get(run.name)?.(run.args) ?? []);
}
