import type { SecretGuardConfig } from '../config/types.ts';
import { DEFAULT_SECRET_ENV_NAMES, SecretNames } from './names.ts';
import { DEFAULT_SECRET_PATHS, SecretPaths } from './paths.ts';

/** What the secret guard treats as secret on this host. */
export interface SecretRules {
  readonly paths: SecretPaths;
  readonly names: SecretNames;
  /** The home folder: `~` and the home variables name it. */
  readonly home: string;
}

/** The defaults, then the team's own globs and patterns; file names ignore case on Windows and macOS hosts. */
export function secretRulesOf(config: SecretGuardConfig, home: string, platform: NodeJS.Platform): SecretRules {
  const ignoreCase = platform === 'win32' || platform === 'darwin';
  return {
    paths: new SecretPaths([...DEFAULT_SECRET_PATHS, ...config.paths], home, ignoreCase),
    names: new SecretNames([...DEFAULT_SECRET_ENV_NAMES, ...config.envNames]),
    home,
  };
}
