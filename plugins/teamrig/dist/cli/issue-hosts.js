import { loadConnector } from "../composition/loader.js";
import { programOverGh } from "../github/gh-program.js";
import { RefusedError } from "./runtime.js";
/**
 * A host's connector adapter gave no host. The adapters ship with teamrig, so this is teamrig's own fault and never
 * something the caller asked wrongly: it ends the command as a failure, not a refusal.
 */
export class HostAdapterError extends Error {
    name = 'HostAdapterError';
    constructor(kind, reasons) {
        super(`the ${kind} connector adapter gave no host: ${reasons.join('; ')}`);
    }
}
/**
 * The tracker and the code host of a host kind (issues/host.ts), built by the connector adapter whose id the kind
 * is: the one place the CLI reaches a host's code, and it names none. A command asks once per run and keeps the
 * answer, so the run reads each owner's saved key once. `stamp` is the team's github.stamp: whether each text posted
 * ends with the made-with-teamrig footer.
 *
 * The adapter is handed the CLI's own gh runner as its program runner (github/gh-program.ts), so every run it makes
 * still passes that runner's rules. Both ports are asked of every adapter, as every command here was written for a
 * host that is both; a tracker with no code host needs its commands to ask for the tracker alone first.
 */
export async function hostsOf(kind, runtime, scanner, stamp, load = loadConnector) {
    const loaded = await load(kind);
    if (loaded.kind === 'refused') {
        throw new HostAdapterError(kind, loaded.notices);
    }
    const { tracker, codeHost } = loaded.value.create({
        run: programOverGh(runtime.gh, runtime.env),
        http: runtime.http,
        credentials: runtime.credentials,
        env: runtime.env,
        scanner,
        stamp,
    });
    if (tracker === undefined || codeHost === undefined) {
        throw new HostAdapterError(kind, [...(tracker === undefined ? ['it builds no tracker'] : []), ...(codeHost === undefined ? ['it builds no code host'] : [])]);
    }
    return { tracker, codeHost };
}
/** The repositories to read: every one of `github.repos`, or the one `--repo` names, which must be among them. */
export function reposOf(repos, asked) {
    if (asked === undefined) {
        return repos;
    }
    const repo = asked.trim().toLowerCase();
    if (!repos.includes(repo)) {
        throw new RefusedError(`--repo ${asked} is not one of github.repos (${repos.join(', ')})`);
    }
    return [repo];
}
