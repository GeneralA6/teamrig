import { isRecord, isStringArray } from '../core/guards.ts';
import type { Env } from '../core/home.ts';
import type { ProgramRunner } from '../core/program-runner.ts';
import type { HostPorts, SessionVariables } from '../ports/host/index.ts';
import { adapterEntry, declarationProblems, type AdapterDeclaration } from './declaration.ts';

/** What the adapter of an AI CLI says of itself. */
export interface HostDeclaration extends AdapterDeclaration<'host'> {
  /**
   * The variables the tool tells a run about its session by. They are declared, not asked of a built port: the load
   * refuses a host that names no mark of an agent's run before any command runs under it.
   */
  readonly sessionVariables: SessionVariables;
}

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

/** A name every shell teamrig reads takes for an environment variable. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * What a host declaring no mark is told. A command that acts as the owner runs only outside an agent's run, and a
 * mark is all that tells teamrig the two apart, so a host without one is refused at its load and the text says what
 * to declare.
 */
export const NO_AGENT_MARK =
  "it declares no mark of an agent's run: sessionVariables.marks must name an environment variable the tool sets in what its agent runs (its tools, what they run, its hooks) and in nothing the person starts";

function isVariableNames(value: unknown): value is readonly string[] {
  return isStringArray(value) && value.every((name) => VARIABLE_NAME.test(name));
}

/** What is wrong with the session variables a host declares; a declaration that is no object is told so elsewhere. */
function sessionVariableProblems(value: unknown): readonly string[] {
  if (!isRecord(value)) {
    return [];
  }
  const variables = value['sessionVariables'];
  const marks = isRecord(variables) ? variables['marks'] : undefined;
  const identity = isRecord(variables) ? variables['identity'] : undefined;
  const noMark = marks === undefined || (Array.isArray(marks) && marks.length === 0);
  return [
    ...(noMark ? [NO_AGENT_MARK] : isVariableNames(marks) ? [] : ['its sessionVariables.marks must be names of environment variables']),
    ...(isVariableNames(identity) ? [] : ['its sessionVariables.identity must be names of environment variables, an empty list when it has none']),
  ];
}

export function hostDeclarationProblems(value: unknown): readonly string[] {
  return [...declarationProblems('host', value), ...sessionVariableProblems(value)];
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
