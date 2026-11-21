/** Whether a feature runs for a team on one adapter. */
export type Toggle = 'on' | 'off';

/**
 * Which kind of adapter carries a feature: an AI CLI (a host), an outside tool (a connector), or the program whose
 * panes the sessions run in (a terminal).
 */
export type FeatureSide = 'host' | 'connector' | 'terminal';

/** What a connector is to the team: where its issues live, or where its code and pull requests do. */
export const CONNECTOR_KINDS = ['tracker', 'codehost'] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

export function isConnectorKind(value: unknown): value is ConnectorKind {
  return CONNECTOR_KINDS.some((kind) => kind === value);
}

/** One host feature: what it does in a line, and whether it runs when an adapter supports it only in part. */
export interface HostFeature {
  readonly doc: string;
  readonly byDefault: Toggle;
}

/** One connector feature, and the kind of connector it needs. */
export interface ConnectorFeature<Kind extends ConnectorKind = ConnectorKind> extends HostFeature {
  readonly kind: Kind;
}

/**
 * The rows of one host group, as its file under `host/` holds them: every id starts with the group's name, so a row
 * written in another group's file does not compile.
 */
export type HostGroup<Group extends string> = Readonly<Record<`${Group}.${string}`, HostFeature>>;

/** The rows of one kind of connector, as its file under `connector/` holds them: ids and `kind` both name the kind. */
export type ConnectorGroup<Kind extends ConnectorKind> = Readonly<Record<`${Kind}.${string}`, ConnectorFeature<Kind>>>;

/** One terminal feature: a request of the terminal protocol, or something a terminal can see of its panes. */
export type TerminalFeature = HostFeature;

/** The rows of one terminal group, as its file under `terminal/` holds them: every id starts with the group's name. */
export type TerminalGroup<Group extends string> = Readonly<Record<`${Group}.${string}`, TerminalFeature>>;
