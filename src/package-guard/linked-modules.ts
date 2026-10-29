import { resolveDir } from '../push-guard/location.ts';
import type { WorktreeFiles } from '../worktree/files.ts';
import { BUN_INSTALL_VALUED, installWordsOf, NPM_INSTALL_VALUED, NPM_INSTALLS, NPM_UPDATES, PNPM_INSTALL_VALUED, YARN_INSTALL_VALUED } from './installs.ts';
import { pathRules } from './local-bin.ts';
import { programsOf, type ProgramRun, type ProgramsContext } from './programs.ts';
import { BUN_VALUED, NPM_VALUED, PNPM_VALUED, subcommandOf, YARN_VALUED } from './runners.ts';

/**
 * The package-manager calls in a command line that would write through a linked node_modules: a symlink, or a
 * junction from a worktree to the main checkout's. Every call that rewrites node_modules counts (an install from the
 * lockfile such as `npm ci` or a bare `yarn`, an add, an update, a removal, a prune, a dedupe), as it rewrites the
 * folder the link points to for every checkout sharing it, and `npm ci` empties it first; a global install writes
 * elsewhere and does not. A habit guard, not a security boundary, as the install guard is: a line built at run time
 * (`eval "$X"`), a folder only known when the line runs, or an install started by another program is not seen.
 */

/** A call that would write through a node_modules link: how it shows in a refusal (`npm ci`), the link, and where it points. */
export interface LinkedModulesWrite {
  readonly call: string;
  readonly modules: string;
  readonly target: string;
}

/** What the guard reads of the tree: what is at a path without following a link, and where a link points. */
export type LinkReader = Pick<WorktreeFiles, 'kindOf' | 'linkTarget'>;

/** How one package manager rewrites node_modules. */
interface Manager {
  /** Its subcommands that rewrite node_modules; '' for a bare call that installs (`yarn`). */
  readonly writes: ReadonlySet<string>;
  /** Its options before the subcommand that take a value. */
  readonly valued: ReadonlySet<string>;
  /** Its options after the subcommand that take a value. */
  readonly installValued: ReadonlySet<string>;
  /** The options naming the folder it installs into instead of the one it starts in. */
  readonly folder: readonly string[];
}

/** npm's `ci`, `install-ci-test`, `uninstall` and `dedupe` with their aliases, beside its installs and updates. */
const NPM_WRITES: ReadonlySet<string> = new Set([
  ...NPM_INSTALLS,
  ...NPM_UPDATES,
  ...['ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean', 'install-ci-test', 'cit', 'clean-install-test', 'sit'],
  ...['uninstall', 'unlink', 'remove', 'rm', 'r', 'un', 'prune', 'dedupe', 'ddp'],
]);

/** Each package manager by program name. */
const MANAGERS: ReadonlyMap<string, Manager> = new Map([
  ['npm', { writes: NPM_WRITES, valued: NPM_VALUED, installValued: NPM_INSTALL_VALUED, folder: ['--prefix'] }],
  [
    'pnpm',
    {
      writes: new Set(['install', 'i', 'install-test', 'it', 'add', 'update', 'up', 'upgrade', 'remove', 'rm', 'uninstall', 'un', 'prune', 'dedupe']),
      valued: PNPM_VALUED,
      installValued: PNPM_INSTALL_VALUED,
      folder: ['-C', '--dir'],
    },
  ],
  ['yarn', { writes: new Set(['', 'install', 'add', 'remove', 'upgrade', 'up', 'upgrade-interactive', 'dedupe']), valued: YARN_VALUED, installValued: YARN_INSTALL_VALUED, folder: ['--cwd'] }],
  ['bun', { writes: new Set(['install', 'i', 'add', 'a', 'remove', 'rm', 'update']), valued: BUN_VALUED, installValued: BUN_INSTALL_VALUED, folder: ['--cwd'] }],
]);

/** A call that rewrites node_modules, and the folder it starts from (undefined when only known when the line runs); undefined for any other run. */
function modulesWriteOf(run: ProgramRun, home: string): { readonly call: string; readonly dir: string | undefined } | undefined {
  const manager = MANAGERS.get(run.name);
  if (manager === undefined) {
    return undefined;
  }
  const { name, rest, options } = subcommandOf(run.args, manager.valued);
  // A subcommand only known when the line runs leaves name undefined, as a bare call does: only the bare one installs.
  const subcommand = options.rest.length === 0 ? '' : name;
  if (subcommand === undefined || !manager.writes.has(subcommand)) {
    return undefined;
  }
  const words = installWordsOf(rest, manager.installValued);
  const valueOf = (option: string) => options.values.get(option) ?? words.values.get(option);
  const global = ['-g', '--global'].some((flag) => options.flags.has(flag) || words.flags.has(flag)) || valueOf('--location')?.text === 'global';
  if (global) {
    return undefined;
  }
  const call = subcommand === '' ? run.name : `${run.name} ${subcommand}`;
  const folder = manager.folder.map(valueOf).find((word) => word !== undefined);
  return { call, dir: folder === undefined ? run.dir : folder.dynamic ? undefined : resolveDir(run.dir, folder.text, home) };
}

/**
 * The node_modules link in `dir` or a folder above it, and where it points; undefined when there is none. A call in a
 * subfolder, or in a workspace package, installs into the project root above it, so every folder up to the root counts.
 */
async function linkAbove(tree: LinkReader, dir: string): Promise<{ readonly modules: string; readonly target: string } | undefined> {
  const rules = pathRules(dir);
  const at = rules.resolve(dir);
  const modules = rules.join(at, 'node_modules');
  if ((await tree.kindOf(modules)) === 'link') {
    return { modules, target: await tree.linkTarget(modules) };
  }
  const parent = rules.dirname(at);
  return parent === at ? undefined : linkAbove(tree, parent);
}

/** The calls `command` makes that would write through a node_modules link; see {@link LinkedModulesWrite}. */
export async function linkedModulesWritesOf(command: string, context: ProgramsContext, tree: LinkReader): Promise<LinkedModulesWrite[]> {
  const found: LinkedModulesWrite[] = [];
  for (const run of programsOf(command, context)) {
    const write = modulesWriteOf(run, context.home);
    const link = write?.dir === undefined ? undefined : await linkAbove(tree, write.dir);
    if (write !== undefined && link !== undefined) {
      found.push({ call: write.call, ...link });
    }
  }
  return found;
}
