import type { Env } from '../core/home.ts';
import type { ProgramRunner } from '../core/program-runner.ts';
import type { HostPorts } from '../ports/host/index.ts';
import { adapterEntry, declarationProblems, type AdapterDeclaration } from './declaration.ts';

/** What the adapter of an AI CLI says of itself. */
export type HostDeclaration = AdapterDeclaration<'host'>;

/** What the loader hands a host adapter to build its ports from: nothing else of teamrig reaches it. */
export interface HostDeps {
  readonly env: Env;
  readonly platform: NodeJS.Platform;
  readonly run: ProgramRunner;
}

/**
 * The adapter of one AI CLI: its declaration, and the ports it builds once the loader has accepted it. `create`
 * answers for every host port, so the core gets each one typed and an adapter cannot leave one unnamed.
 */
export interface HostAdapter<Ports extends HostPorts = HostPorts> {
  readonly declaration: HostDeclaration;
  readonly create: (deps: HostDeps) => Ports;
}

/** The default export of a host adapter's entry. */
export function defineHost<Ports extends HostPorts>(adapter: HostAdapter<Ports>): HostAdapter<Ports> {
  return adapter;
}

export function hostDeclarationProblems(value: unknown): readonly string[] {
  return declarationProblems('host', value);
}

export function isHostDeclaration(value: unknown): value is HostDeclaration {
  return hostDeclarationProblems(value).length === 0;
}

/** What stops `value` from being a host adapter's entry; empty when it is one. */
export function hostAdapterProblems(value: unknown): readonly string[] {
  const entry = adapterEntry(value);
  return entry === undefined ? ['its entry is not made by defineHost: it needs a declaration and a create function'] : hostDeclarationProblems(entry.declaration);
}

export function isHostAdapter(value: unknown): value is HostAdapter {
  return hostAdapterProblems(value).length === 0;
}
