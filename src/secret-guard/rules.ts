import type { SecretGuardConfig } from '../config/types.ts';
import { SecretShapes } from '../core/secret-shapes.ts';
import type { HostPaths } from '../ports/host/index.ts';
import { DEFAULT_SECRET_COMMANDS } from './commands.ts';
import { DEFAULT_SECRET_ENV_NAMES, SecretNames } from './names.ts';
import { DEFAULT_SECRET_PATHS, SecretPaths } from './paths.ts';
import { PatternList } from './pattern-list.ts';
import { readKeyText } from './public-key.ts';

/** What the secret guard treats as secret on this host. */
export interface SecretRules {
  readonly paths: SecretPaths;
  readonly names: SecretNames;
  /** The commands whose output is a secret (`kubectl config view --raw`). */
  readonly commands: PatternList;
  /** The shapes a secret written into a command line is found by. */
  readonly shapes: SecretShapes;
  /** The home folder: `~` and the home variables name it. */
  readonly home: string;
}

/** Who tells the host's own secret files: its paths, or a stand-in naming none where no folder of the host is known. */
export type HostSecretFiles = Pick<HostPaths, 'secretFiles'>;

/**
 * The globs `host` names. A `!glob` among them is left out: a host adds secret files, and only a team's own `!glob`
 * keeps a file readable, so no host can open what the defaults or another host keeps.
 */
function hostGlobs(host: HostSecretFiles): readonly string[] {
  return host.secretFiles().filter((glob) => !glob.startsWith('!'));
}

/**
 * The defaults, then the team's own globs, names and commands; file names ignore case on Windows and macOS hosts.
 * The secret files of `host` come between the default globs and the team's: the last glob that matches decides, so
 * a team's `!glob` can still keep one of the host's readable. They are not optional and not a list, so no caller
 * leaves them out or hands the team's patterns in their place.
 * `secretPatterns` are the team's `register.secretPatterns`, added to the write-time shapes.
 */
export function secretRulesOf(
  config: SecretGuardConfig,
  home: string,
  platform: NodeJS.Platform,
  host: HostSecretFiles,
  secretPatterns: readonly string[] = [],
): SecretRules {
  const ignoreCase = platform === 'win32' || platform === 'darwin';
  return {
    paths: new SecretPaths([...DEFAULT_SECRET_PATHS, ...hostGlobs(host), ...config.paths], home, ignoreCase, readKeyText),
    names: new SecretNames([...DEFAULT_SECRET_ENV_NAMES, ...config.envNames]),
    commands: new PatternList([...DEFAULT_SECRET_COMMANDS, ...config.commands]),
    shapes: new SecretShapes(secretPatterns),
    home,
  };
}
