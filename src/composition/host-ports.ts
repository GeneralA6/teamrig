import type { HostDeps, HostPorts, ProgramRunner } from '../plugin-api/index.ts';
import { DEFAULT_HOST } from './adapters.ts';
import { importModule, loadHost, type ModuleImporter } from './loader.ts';

/** How long one program a host port runs may take: the limit the process's other system queries run under. */
export const HOST_PROGRAM_TIMEOUT_MS = 30_000;

/**
 * Builds the host ports for the environment and platform one run sees. They are asked for per run, never fixed at
 * load: a spec's world has its own environment, and the adapter must read that one.
 */
export type HostSource = (seen: Pick<HostDeps, 'env' | 'platform'>) => HostPorts;

/**
 * Loads the host adapter teamrig runs in, once per process, and gives the way to build its ports. A refused
 * adapter throws every reason: no command can do its work without the host, so this is a start failure, not a
 * port the core could word a refusal for.
 */
export async function loadHostPorts(run: ProgramRunner, importer: ModuleImporter = importModule): Promise<HostSource> {
  const load = await loadHost(DEFAULT_HOST, importer);
  if (load.kind === 'refused') {
    throw new Error(`the host adapter ${load.id} did not load: ${load.notices.join('; ')}`);
  }
  const adapter = load.value;
  return (seen) => adapter.create({ ...seen, run });
}
