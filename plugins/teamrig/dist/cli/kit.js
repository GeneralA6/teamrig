import { loadConfig } from "../config/load.js";
import { kitPaths, resolveKitHome } from "../core/home.js";
import { RefusedError } from "./runtime.js";
/** The kit home, its config and the paths the config moves. */
export async function openKit(runtime) {
    const home = resolveKitHome(runtime.env, runtime.userHome);
    const load = await loadConfig(runtime.files, kitPaths(home, runtime.userHome).config);
    const overrides = load.status === 'loaded' ? load.config.paths : {};
    return { load, paths: kitPaths(home, runtime.userHome, overrides) };
}
export function issueText(issue) {
    return `${issue.path === '' ? '(top level)' : issue.path}: ${issue.message}`;
}
/**
 * The team config. A config with problems still loads, each bad field on its default: reads go
 * on with a warning, writes are refused until it is fixed. A config from a newer teamrig is read
 * best-effort and never written through.
 */
export function requireConfig(kit, runtime, access) {
    const { load } = kit;
    switch (load.status) {
        case 'missing':
            throw new RefusedError(`no team config at ${load.path}; write one (see the README), then run: teamrig config validate`);
        case 'unreadable':
            throw new RefusedError(`the team config at ${load.path} cannot be read: ${issueText(load.issue)}`);
        case 'loaded':
            break;
    }
    const [first] = load.issues;
    const newer = load.newerVersion === undefined ? undefined : `${load.path} is config version ${load.newerVersion}, from a newer teamrig; update teamrig`;
    if (access === 'write') {
        if (newer !== undefined) {
            throw new RefusedError(`${newer} before writing`);
        }
        if (first !== undefined) {
            throw new RefusedError(`the team config has ${load.issues.length} problem(s) (first: ${issueText(first)}); run: teamrig config validate`);
        }
    }
    if (newer !== undefined) {
        runtime.out.stderr(`WARN ${newer}; reading it best-effort`);
    }
    if (first !== undefined) {
        runtime.out.stderr(`WARN config: ${load.issues.length} problem(s), defaults used (first: ${issueText(first)}); run: teamrig config validate`);
    }
    return load.config;
}
