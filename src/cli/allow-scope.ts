import type { KitConfig } from '../config/types.ts';
import { teamPlace } from '../delivery/places.ts';
import type { TeamPaths } from '../core/home.ts';
import { SecretScanner } from '../core/secrets.ts';
import { KeepList } from '../permissions/allow-rules.ts';
import { ownUntracked, settingsScope, type SettingsFile, type SettingsInGit } from '../permissions/settings-scope.ts';
import { planScope, wideAllowOf, type WideAllow } from '../permissions/trim.ts';
import type { HostPaths } from '../ports/host/index.ts';
import { pathsIfKnown } from './host.ts';
import type { CliRuntime } from './runtime.ts';

/** Where a team's sessions run: its kit home, its config and the project folder (`projectFolder`). */
export interface AllowScopeInput {
  readonly paths: Pick<TeamPaths, 'home'>;
  readonly config: KitConfig;
  readonly project: string;
}

/**
 * The host's settings files a team's sessions run under, where `host` keeps them, for `permissions trim` and its flag
 * in doctor and `check` (which `start` shows the lead): the person's user settings, the project folder and each
 * repository teamrig merges into (`delivery.repos`), each with the worktrees the host made in it.
 */
export async function teamSettingsScope(runtime: CliRuntime, host: HostPaths, { paths, config, project }: AllowScopeInput): Promise<SettingsFile[]> {
  const repos = Object.values(config.delivery.repos).map((repo) => teamPlace(paths, repo.mainCheckout));
  return projectsSettingsScope(runtime, host, [project, ...repos]);
}

/**
 * That scope for a caller that only reads it and must go on, such as `check`: on a host whose folders teamrig does
 * not know it holds no file, so nothing is flagged there.
 */
export async function knownSettingsScope(runtime: CliRuntime, input: AllowScopeInput): Promise<SettingsFile[]> {
  const host = pathsIfKnown(runtime);
  return host === undefined ? [] : teamSettingsScope(runtime, host, input);
}

/** The settings files of the user and `projects` (`settingsScope`), each project file its repository does not track read as the person's own (#837). */
export async function projectsSettingsScope(runtime: CliRuntime, host: HostPaths, projects: readonly string[]): Promise<SettingsFile[]> {
  const scope = await settingsScope(runtime.files, { paths: host, userHome: runtime.userHome }, projects, runtime.platform);
  return ownUntracked(runtime.files, scope, (path) => settingsInGit(runtime, path));
}

/** git's word on a settings file through the kit's git runner (the team pointer's port): only `tracked` is committed; no repository or no answer is unknown. */
function settingsInGit(runtime: CliRuntime, path: string): SettingsInGit {
  switch (runtime.pointerGit.state(path).kind) {
    case 'tracked':
      return 'tracked';
    case 'ignored':
    case 'open':
      return 'untracked';
    case 'no-git':
      return 'unknown';
  }
}

/**
 * The rules off the team's keep-list that approve a whole tool or program or hold a credential, in every file of its
 * scope: none on a host whose folders teamrig does not know (`knownSettingsScope`).
 */
export async function readWideAllow(runtime: CliRuntime, input: AllowScopeInput): Promise<WideAllow> {
  const { config } = input;
  const plans = await planScope(runtime.files, await knownSettingsScope(runtime, input), new KeepList(config.permissions.keepAllow), 'wide', new SecretScanner(config.register.secretPatterns));
  return wideAllowOf(plans);
}
