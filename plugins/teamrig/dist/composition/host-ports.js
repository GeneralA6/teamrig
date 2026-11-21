import { DEFAULT_HOST } from "./adapters.js";
import { importModule, loadHost } from "./loader.js";
/** How long one program a host port runs may take: the limit the process's other system queries run under. */
export const HOST_PROGRAM_TIMEOUT_MS = 30_000;
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
    return (seen) => adapter.create({ ...seen, run });
}
