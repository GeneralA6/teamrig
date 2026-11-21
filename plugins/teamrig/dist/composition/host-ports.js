import { isRecord } from "../core/guards.js";
import { HOST_PORT_NAMES } from "../ports/host/index.js";
import { DEFAULT_HOST } from "./adapters.js";
import { importModule, loadHost } from "./loader.js";
/** How long one program a host port runs may take: the limit the process's other system queries run under. */
export const HOST_PROGRAM_TIMEOUT_MS = 30_000;
/**
 * What stops `built` from being every host port; empty when it is. An adapter's `create` is typed, but the type
 * holds only an adapter compiled against this release's ports, so what it built is read as a value.
 */
function portProblems(built) {
    if (!isRecord(built))
        return ['its create function built no ports'];
    return HOST_PORT_NAMES.filter((name) => !isRecord(built[name])).map((name) => `it builds no ${name} port: a port its tool cannot fill is an unsupported(reason)`);
}
/** The ports `adapter` builds from `deps`; one that leaves a port unnamed throws every reason, as a refused load does. */
function build(adapter, id, deps) {
    const ports = adapter.create(deps);
    const problems = portProblems(ports);
    if (problems.length > 0) {
        throw new Error(`the host adapter ${id} cannot be used: ${problems.join('; ')}`);
    }
    return ports;
}
/**
 * Loads the host adapter teamrig runs in, once per process, and gives the way to build its ports. A refused
 * adapter throws every reason: no command can do its work without the host, so this is a start failure, not a
 * port the core could word a refusal for.
 */
export async function loadHostPorts(run, importer = importModule) {
    const load = await loadHost(DEFAULT_HOST, importer);
    if (load.kind === 'refused') {
        throw new Error(`the host adapter ${load.id} did not load: ${load.notices.join('; ')}`);
    }
    const adapter = load.value;
    return (seen) => build(adapter, load.id, { ...seen, run });
}
