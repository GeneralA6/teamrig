import type { KitConfig } from '../config/types.ts';
import { teamPlace } from '../coordinator/places.ts';
import { claudeConfigDir, type TeamPaths } from '../core/home.ts';
import { SecretScanner } from '../core/secrets.ts';
import { KeepList } from '../permissions/allow-rules.ts';
import { settingsScope, type SettingsFile } from '../permissions/settings-scope.ts';
import { planScope, wideAllowOf, type WideAllow } from '../permissions/trim.ts';
import type { CliRuntime } from './runtime.ts';

/** Where a team's sessions run: its kit home, its config and the project folder (`projectFolder`). */
export interface AllowScopeInput {
  readonly paths: Pick<TeamPaths, 'home'>;
  readonly config: KitConfig;
  readonly project: string;
}

/**
 * The Claude Code settings files a team's sessions run under, for `permissions trim` and its flag in doctor and `check`
 * (which `start` shows the lead): the person's user settings, the project folder and each repository the coordinator
 * merges into (`delivery.repos`), each with the worktrees Claude Code made in it.
 */
export async function teamSettingsScope(runtime: CliRuntime, { paths, config, project }: AllowScopeInput): Promise<SettingsFile[]> {
  const repos = Object.values(config.delivery.repos).map((repo) => teamPlace(paths, repo.mainCheckout));
  return settingsScope(runtime.files, claudeConfigDir(runtime.env, runtime.userHome), [project, ...repos], runtime.platform);
}

/** The rules off the team's keep-list that approve a whole tool or program or hold a credential, in every file of its scope. */
export async function readWideAllow(runtime: CliRuntime, input: AllowScopeInput): Promise<WideAllow> {
  const { config } = input;
  const plans = await planScope(runtime.files, await teamSettingsScope(runtime, input), new KeepList(config.permissions.keepAllow), 'wide', new SecretScanner(config.register.secretPatterns));
  return wideAllowOf(plans);
}
