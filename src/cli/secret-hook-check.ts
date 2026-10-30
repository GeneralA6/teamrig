import { basename, dirname, join } from 'node:path';
import type { CoordinatorConfig } from '../config/types.ts';
import { teamPlace } from '../delivery/places.ts';
import type { Files } from '../core/files.ts';
import { KIT_NAME, type TeamPaths } from '../core/home.ts';
import type { SecretsGit } from '../secret-guard/secrets-git.ts';
import type { UnownedWarning } from './unowned.ts';

/** A git hook `teamrig secrets` guards (T1480): the `secrets` subcommand its script calls, and the line that calls it. */
export interface SecretHook {
  readonly hook: string;
  readonly sub: string;
  readonly line: string;
}

/** The hooks every repository the team merges into runs the secret scan in, in the order git runs them. */
export const SECRET_HOOKS: readonly SecretHook[] = [
  { hook: 'pre-commit', sub: 'staged', line: `${KIT_NAME} secrets staged || exit 1` },
  { hook: 'commit-msg', sub: 'message', line: `${KIT_NAME} secrets message "$1" || exit 1` },
  { hook: 'pre-push', sub: 'pushed', line: `${KIT_NAME} secrets pushed "$1" || exit 1` },
];

/**
 * Whether a line of a hook script, other than a comment line, calls its `secrets` subcommand: through the `teamrig`
 * command, or `src/cli/main.ts` in teamrig's own repository, which runs its source.
 */
export function callsSecretScan(script: string, hook: SecretHook): boolean {
  const call = new RegExp(`(?:\\b${KIT_NAME}|cli/main\\.ts)\\s+secrets\\s+${hook.sub}\\b`);
  return script.split('\n').some((line) => !line.trimStart().startsWith('#') && call.test(line));
}

/** The folder holding the hook scripts a person writes: husky points git at `.husky/_`, whose hooks run `.husky/<hook>`. */
export function hookScriptsDir(hooksDir: string): string {
  const parent = dirname(hooksDir);
  return basename(hooksDir) === '_' && basename(parent) === '.husky' ? parent : hooksDir;
}

function warning(name: string, text: string): UnownedWarning {
  return { key: `secret-hook ${name}`, source: 'the secret hook check [delivery.repos]', text: `SECRET-HOOK ${name} ${text}` };
}

/** The repository's warning: the hooks that lack the scan and the line to add to each; none when all three run it. */
async function repoWarning(files: Files, git: SecretsGit, name: string, main: string): Promise<UnownedWarning | undefined> {
  const hooksDir = git.hooksDir(main);
  if (hooksDir === undefined) {
    return warning(name, `(${main}): git reads no repository there, so its hooks could not be checked for the secret scan`);
  }
  const scripts = hookScriptsDir(hooksDir);
  const missing: SecretHook[] = [];
  for (const hook of SECRET_HOOKS) {
    if (!callsSecretScan((await files.read(join(scripts, hook.hook))) ?? '', hook)) {
      missing.push(hook);
    }
  }
  if (missing.length === 0) {
    return undefined;
  }
  const adds = missing.map((hook) => `\`${hook.line}\` to ${hook.hook}`).join(', ');
  return warning(name, `(${scripts}) runs no secret scan in ${missing.map((hook) => hook.hook).join(', ')}, so a secret there can be committed or pushed: add ${adds}`);
}

/**
 * SECRET-HOOK (T1480), for `check`: each repository the team merges into (`delivery.repos`) whose pre-commit,
 * commit-msg or pre-push script does not call `teamrig secrets`, or which git cannot read. A repository's hooks are
 * its own, not one session's area, so it is a warning no session owns and goes to the lead. One git call per
 * repository, then a read of its three scripts.
 */
export async function secretHookWarnings(files: Files, git: SecretsGit, paths: Pick<TeamPaths, 'home'>, repos: CoordinatorConfig['repos']): Promise<UnownedWarning[]> {
  const warnings: UnownedWarning[] = [];
  for (const [name, repo] of Object.entries(repos)) {
    const found = await repoWarning(files, git, name, teamPlace(paths, repo.mainCheckout));
    if (found !== undefined) {
      warnings.push(found);
    }
  }
  return warnings;
}
