import type { DeliveryConfig } from '../config/types.ts';
import { teamPlace } from '../delivery/places.ts';
import type { Files } from '../core/files.ts';
import { KIT_NAME, type TeamPaths } from '../core/home.ts';
import { hookScriptsDir, missingHookLines, type HookLine } from '../git-hooks/hook-lines.ts';
import type { SecretsGit } from '../secret-guard/secrets-git.ts';
import type { UnownedWarning } from './unowned.ts';

/** The hooks every repository the team merges into runs the secret scan in, in the order git runs them. */
export const SECRET_HOOKS: readonly HookLine[] = [
  { hook: 'pre-commit', command: 'secrets', sub: 'staged', line: `${KIT_NAME} secrets staged || exit 1` },
  { hook: 'commit-msg', command: 'secrets', sub: 'message', line: `${KIT_NAME} secrets message "$1" || exit 1` },
  { hook: 'pre-push', command: 'secrets', sub: 'pushed', line: `${KIT_NAME} secrets pushed "$1" || exit 1` },
];

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
  const missing = await missingHookLines(files, scripts, SECRET_HOOKS);
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
export async function secretHookWarnings(files: Files, git: SecretsGit, paths: Pick<TeamPaths, 'home'>, repos: DeliveryConfig['repos']): Promise<UnownedWarning[]> {
  const warnings: UnownedWarning[] = [];
  for (const [name, repo] of Object.entries(repos)) {
    const found = await repoWarning(files, git, name, teamPlace(paths, repo.mainCheckout));
    if (found !== undefined) {
      warnings.push(found);
    }
  }
  return warnings;
}
