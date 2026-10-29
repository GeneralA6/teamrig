import { resolveDir } from "../push-guard/location.js";
import { BUN_INSTALL_VALUED, installWordsOf, NPM_INSTALL_VALUED, NPM_INSTALLS, NPM_UPDATES, PNPM_INSTALL_VALUED, YARN_INSTALL_VALUED } from "./installs.js";
import { pathRules } from "./local-bin.js";
import { programsOf } from "./programs.js";
import { BUN_VALUED, NPM_VALUED, PNPM_VALUED, subcommandOf, YARN_VALUED } from "./runners.js";
/** npm's `ci`, `install-ci-test`, `uninstall` and `dedupe` with their aliases, beside its installs and updates. */
const NPM_WRITES = new Set([
    ...NPM_INSTALLS,
    ...NPM_UPDATES,
    ...['ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean', 'install-ci-test', 'cit', 'clean-install-test', 'sit'],
    ...['uninstall', 'unlink', 'remove', 'rm', 'r', 'un', 'prune', 'dedupe', 'ddp'],
]);
/** Each package manager by program name. */
const MANAGERS = new Map([
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
function modulesWriteOf(run, home) {
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
    const valueOf = (option) => options.values.get(option) ?? words.values.get(option);
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
async function linkAbove(tree, dir) {
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
export async function linkedModulesWritesOf(command, context, tree) {
    const found = [];
    for (const run of programsOf(command, context)) {
        const write = modulesWriteOf(run, context.home);
        const link = write?.dir === undefined ? undefined : await linkAbove(tree, write.dir);
        if (write !== undefined && link !== undefined) {
            found.push({ call: write.call, ...link });
        }
    }
    return found;
}
