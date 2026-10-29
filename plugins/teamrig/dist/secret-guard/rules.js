import { SecretShapes } from "../core/secret-shapes.js";
import { DEFAULT_SECRET_COMMANDS } from "./commands.js";
import { DEFAULT_SECRET_ENV_NAMES, SecretNames } from "./names.js";
import { DEFAULT_SECRET_PATHS, SecretPaths } from "./paths.js";
import { PatternList } from "./pattern-list.js";
/**
 * The defaults, then the team's own globs, names and commands; file names ignore case on Windows and macOS hosts.
 * `secretPatterns` are the team's `register.secretPatterns`, added to the write-time shapes.
 */
export function secretRulesOf(config, home, platform, secretPatterns = []) {
    const ignoreCase = platform === 'win32' || platform === 'darwin';
    return {
        paths: new SecretPaths([...DEFAULT_SECRET_PATHS, ...config.paths], home, ignoreCase),
        names: new SecretNames([...DEFAULT_SECRET_ENV_NAMES, ...config.envNames]),
        commands: new PatternList([...DEFAULT_SECRET_COMMANDS, ...config.commands]),
        shapes: new SecretShapes(secretPatterns),
        home,
    };
}
