import { DEFAULT_SECRET_ENV_NAMES, SecretNames } from "./names.js";
import { DEFAULT_SECRET_PATHS, SecretPaths } from "./paths.js";
/** The defaults, then the team's own globs and patterns; file names ignore case on Windows and macOS hosts. */
export function secretRulesOf(config, home, platform) {
    const ignoreCase = platform === 'win32' || platform === 'darwin';
    return {
        paths: new SecretPaths([...DEFAULT_SECRET_PATHS, ...config.paths], home, ignoreCase),
        names: new SecretNames([...DEFAULT_SECRET_ENV_NAMES, ...config.envNames]),
        home,
    };
}
