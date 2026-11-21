import { CODEHOST_FEATURES } from './connector/codehost.ts';
import { TRACKER_FEATURES } from './connector/tracker.ts';
import type { ConnectorFeature, FeatureSide, HostFeature, TerminalFeature, Toggle } from './feature.ts';
import { BUDGET_FEATURES } from './host/budget.ts';
import { CONTEXT_FEATURES } from './host/context.ts';
import { ERRORS_FEATURES } from './host/errors.ts';
import { HELPERS_FEATURES } from './host/helpers.ts';
import { HOOKS_FEATURES } from './host/hooks.ts';
import { INBOX_FEATURES } from './host/inbox.ts';
import { OS_FEATURES } from './host/os.ts';
import { PERMISSIONS_FEATURES } from './host/permissions.ts';
import { PLUGIN_FEATURES } from './host/plugin.ts';
import { RULES_FEATURES } from './host/rules.ts';
import { SESSIONS_FEATURES } from './host/sessions.ts';
import { SKILLS_FEATURES } from './host/skills.ts';
import { TABS_FEATURES } from './host/tabs.ts';
import { WAKE_FEATURES } from './host/wake.ts';
import { PANE_FEATURES } from './terminal/pane.ts';

export { CONNECTOR_KINDS, isConnectorKind, type ConnectorFeature, type ConnectorKind, type FeatureSide, type HostFeature, type TerminalFeature, type Toggle } from './feature.ts';

/**
 * Every feature an AI CLI's adapter must answer for. An id is `<group>.<name>` and never changes once shipped:
 * manifests, team config and the parity page all name a feature by it. Each group's rows live in their own file
 * under `host/`, so two changes adding rows to different groups never touch the same lines; a new row goes at the
 * end of its group's file, a new group in a new file named after it and listed here, in the parity page's order.
 */
export const HOST_FEATURES = {
  ...RULES_FEATURES,
  ...INBOX_FEATURES,
  ...CONTEXT_FEATURES,
  ...HOOKS_FEATURES,
  ...PERMISSIONS_FEATURES,
  ...SESSIONS_FEATURES,
  ...TABS_FEATURES,
  ...WAKE_FEATURES,
  ...SKILLS_FEATURES,
  ...HELPERS_FEATURES,
  ...PLUGIN_FEATURES,
  ...BUDGET_FEATURES,
  ...ERRORS_FEATURES,
  ...OS_FEATURES,
} as const satisfies Readonly<Record<string, HostFeature>>;

/**
 * Every feature an outside tool's adapter must answer for; an id is `<kind>.<name>`. Each kind's rows live in their
 * own file under `connector/`.
 */
export const CONNECTOR_FEATURES = {
  ...TRACKER_FEATURES,
  ...CODEHOST_FEATURES,
} as const satisfies Readonly<Record<string, ConnectorFeature>>;

/**
 * Every feature a terminal's adapter must answer for; an id is `<group>.<name>`. Each group's rows live in their own
 * file under `terminal/`.
 */
export const TERMINAL_FEATURES = {
  ...PANE_FEATURES,
} as const satisfies Readonly<Record<string, TerminalFeature>>;

export type HostFeatureId = keyof typeof HOST_FEATURES;
export type ConnectorFeatureId = keyof typeof CONNECTOR_FEATURES;
export type TerminalFeatureId = keyof typeof TERMINAL_FEATURES;
export type FeatureId = HostFeatureId | ConnectorFeatureId | TerminalFeatureId;

interface FeatureIdBySide {
  readonly host: HostFeatureId;
  readonly connector: ConnectorFeatureId;
  readonly terminal: TerminalFeatureId;
}

/** The feature ids of one side. */
export type FeatureIdOf<Side extends FeatureSide> = FeatureIdBySide[Side];

export function isHostFeatureId(value: string): value is HostFeatureId {
  return Object.hasOwn(HOST_FEATURES, value);
}

export function isConnectorFeatureId(value: string): value is ConnectorFeatureId {
  return Object.hasOwn(CONNECTOR_FEATURES, value);
}

export function isTerminalFeatureId(value: string): value is TerminalFeatureId {
  return Object.hasOwn(TERMINAL_FEATURES, value);
}

/** One registry row as a reader takes it: of any side, or of the one side whose ids it is given. */
export interface FeatureRow<Id extends FeatureId = FeatureId> {
  readonly id: Id;
  /** The part of the id before its dot: the heading its rows share on the parity page. */
  readonly group: string;
  readonly doc: string;
  readonly byDefault: Toggle;
}

function groupOf(id: string): string {
  return id.slice(0, id.indexOf('.'));
}

const HOST_ROWS: readonly FeatureRow<HostFeatureId>[] = Object.keys(HOST_FEATURES)
  .filter(isHostFeatureId)
  .map((id) => ({ id, group: groupOf(id), doc: HOST_FEATURES[id].doc, byDefault: HOST_FEATURES[id].byDefault }));

const CONNECTOR_ROWS: readonly FeatureRow<ConnectorFeatureId>[] = Object.keys(CONNECTOR_FEATURES)
  .filter(isConnectorFeatureId)
  .map((id) => ({ id, group: CONNECTOR_FEATURES[id].kind, doc: CONNECTOR_FEATURES[id].doc, byDefault: CONNECTOR_FEATURES[id].byDefault }));

const TERMINAL_ROWS: readonly FeatureRow<TerminalFeatureId>[] = Object.keys(TERMINAL_FEATURES)
  .filter(isTerminalFeatureId)
  .map((id) => ({ id, group: groupOf(id), doc: TERMINAL_FEATURES[id].doc, byDefault: TERMINAL_FEATURES[id].byDefault }));

const ROWS: { readonly [Side in FeatureSide]: readonly FeatureRow<FeatureIdOf<Side>>[] } = { host: HOST_ROWS, connector: CONNECTOR_ROWS, terminal: TERMINAL_ROWS };

/** The rows of one side, in registry order. */
export function featuresOf<Side extends FeatureSide>(side: Side): readonly FeatureRow<FeatureIdOf<Side>>[] {
  return ROWS[side];
}
