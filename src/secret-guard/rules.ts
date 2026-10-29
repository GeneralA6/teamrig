import type { SecretGuardConfig } from '../config/types.ts';
import { SecretShapes } from '../core/secret-shapes.ts';
import { DEFAULT_SECRET_COMMANDS } from './commands.ts';
import { DEFAULT_SECRET_ENV_NAMES, SecretNames } from './names.ts';
import { DEFAULT_SECRET_PATHS, SecretPaths } from './paths.ts';
import { PatternList } from './pattern-list.ts';

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

/**
 * The defaults, then the team's own globs, names and commands; file names ignore case on Windows and macOS hosts.
 * `secretPatterns` are the team's `register.secretPatterns`, added to the write-time shapes.
 */
export function secretRulesOf(config: SecretGuardConfig, home: string, platform: NodeJS.Platform, secretPatterns: readonly string[] = []): SecretRules {
  const ignoreCase = platform === 'win32' || platform === 'darwin';
  return {
    paths: new SecretPaths([...DEFAULT_SECRET_PATHS, ...config.paths], home, ignoreCase),
    names: new SecretNames([...DEFAULT_SECRET_ENV_NAMES, ...config.envNames]),
    commands: new PatternList([...DEFAULT_SECRET_COMMANDS, ...config.commands]),
    shapes: new SecretShapes(secretPatterns),
    home,
  };
}
