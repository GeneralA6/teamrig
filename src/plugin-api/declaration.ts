import { isRecord, stringField } from '../core/guards.ts';
import type { FeatureSide } from '../features/registry.ts';
import { manifestProblems, type Manifest } from './support.ts';
import { isApiVersion } from './version.ts';

/**
 * What an adapter says of itself, as data: the parity page and the checks read it without loading the adapter's
 * code.
 */
export interface AdapterDeclaration<Side extends FeatureSide> {
  /** The plugin API version the adapter is built against. */
  readonly apiVersion: string;
  /** Lower-case words joined by `-`: the loader's table, team config and the parity page name the adapter by it. */
  readonly id: string;
  /** The tool's name as a person reads it. */
  readonly name: string;
  readonly manifest: Manifest<Side>;
}

export const ADAPTER_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** What stops `value` from being the declaration of an adapter of one side; empty when it is one. */
export function declarationProblems(side: FeatureSide, value: unknown): readonly string[] {
  if (!isRecord(value)) {
    return ['its declaration is not an object'];
  }
  const apiVersion = stringField(value, 'apiVersion');
  const id = stringField(value, 'id');
  const name = stringField(value, 'name');
  return [
    ...(apiVersion !== undefined && isApiVersion(apiVersion) ? [] : ['its apiVersion must be a version like 1.0.0']),
    ...(id !== undefined && ADAPTER_ID.test(id) ? [] : ['its id must be lower-case words joined by -']),
    ...(name !== undefined && name.trim() !== '' ? [] : ['it needs a name']),
    ...manifestProblems(side, value['manifest']),
  ];
}

/** An adapter's entry as loaded, before its declaration is checked. */
export interface AdapterEntry {
  readonly declaration: unknown;
}

/** The function an adapter's entry holds beside its declaration: a host's or terminal's `create`, a connector's `configure`. */
export type EntryFunction = 'create' | 'configure';

/** The entry when `value` has the shape `defineHost`, `defineConnector` or `defineTerminal` returns: a declaration and the function `needs` names. */
export function adapterEntry(value: unknown, needs: EntryFunction): AdapterEntry | undefined {
  return isRecord(value) && typeof value[needs] === 'function' ? { declaration: value['declaration'] } : undefined;
}
