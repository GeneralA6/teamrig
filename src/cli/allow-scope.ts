import type { KitConfig } from '../config/types.ts';
import { teamPlace } from '../coordinator/places.ts';
import { claudeConfigDir, type TeamPaths } from '../core/home.ts';
import { settingsScope, type SettingsFile } from '../permissions/settings-scope.ts';
import type { CliRuntime } from './runtime.ts';

/** Where a team's sessions run: its kit home, its config and the project folder (`projectFolder`). */
export interface AllowScopeInput {
  readonly paths: Pick<TeamPaths, 'home'>;
  readonly config: KitConfig;
  readonly project: string;
}

/**
 * The Claude Code settings files a team's sessions run under, for `permissions trim`: the person's user settings, the
 * project folder and each repository the coordinator integrates (`coordinator.repos`), each with the worktrees Claude
 * Code made in it.
 */
export async function teamSettingsScope(runtime: CliRuntime, { paths, config, project }: AllowScopeInput): Promise<SettingsFile[]> {
  const repos = Object.values(config.coordinator.repos).map((repo) => teamPlace(paths, repo.mainCheckout));
  return settingsScope(runtime.files, claudeConfigDir(runtime.env, runtime.userHome), [project, ...repos], runtime.platform);
}

