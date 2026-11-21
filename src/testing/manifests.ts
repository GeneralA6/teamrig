import { featuresOf, type FeatureSide } from '../features/registry.ts';
import type { Support } from '../plugin-api/support.ts';

export const SUPPORTED: Support = { kind: 'supported', proofs: [] };
export const UNSUPPORTED: Support = { kind: 'unsupported', notice: 'the tool has no such thing' };

/** A manifest of one side as loaded data: every row `support`, then the rows of `over` in place of theirs. */
export function manifestOf(side: FeatureSide, support: Support = SUPPORTED, over: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { ...Object.fromEntries(featuresOf(side).map((row) => [row.id, support])), ...over };
}

/** A host declaration as loaded data, with the fields of `over` in place of its own. */
export function hostDeclarationData(over: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { apiVersion: '0.1.0', id: 'some-cli', name: 'Some CLI', manifest: manifestOf('host'), ...over };
}

/** A terminal declaration as loaded data, with the fields of `over` in place of its own. */
export function terminalDeclarationData(over: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { apiVersion: '0.1.0', id: 'some-terminal', name: 'Some Terminal', manifest: manifestOf('terminal'), ...over };
}

/** A connector declaration as loaded data, a tracker and a code host, with the fields of `over` in place of its own. */
export function connectorDeclarationData(over: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { apiVersion: '0.1.0', id: 'some-tool', name: 'Some Tool', kinds: ['tracker', 'codehost'], refPrefix: 'st:', manifest: manifestOf('connector'), ...over };
}
