/** Whether a feature runs for a team on one adapter. */
export type Toggle = 'on' | 'off';

/** Which kind of adapter carries a feature: an AI CLI (a host) or an outside tool (a connector). */
export type FeatureSide = 'host' | 'connector';

/** What a connector is to the team: where its issues live, or where its code and pull requests do. */
export type ConnectorKind = 'tracker' | 'codehost';

/** One host feature: what it does in a line, and whether it runs when an adapter supports it only in part. */
export interface HostFeature {
  readonly doc: string;
  readonly byDefault: Toggle;
}

/** One connector feature, and the kind of connector it needs. */
export interface ConnectorFeature extends HostFeature {
  readonly kind: ConnectorKind;
}

/**
 * Every feature an AI CLI's adapter must answer for. An id is `<group>.<name>` and never changes once shipped:
 * manifests, team config and the parity page all name a feature by it.
 */
export const HOST_FEATURES = {
  'rules.session-start': { doc: 'team rules, identity and live tasks at a session start', byDefault: 'on' },
  'rules.instruction-files': { doc: 'the rules files read on every turn', byDefault: 'on' },
  'rules.rules-folder': { doc: 'the rules folder of a project', byDefault: 'on' },
  'rules.memory': { doc: 'memory files kept between sessions', byDefault: 'on' },
  'inbox.prompt-line': { doc: 'inbox lines, the digest and the budget line at each prompt', byDefault: 'on' },
  'context.compact-hold': { doc: 'holding a compaction while a handover is written', byDefault: 'on' },
  'context.size': { doc: 'the context size and its refresh thresholds', byDefault: 'on' },
  'hooks.pretool-guard': { doc: 'the push, package, database-write and directory-hop guards on shell calls', byDefault: 'on' },
  'hooks.file-guard': { doc: 'the secret, service-role and pass-record guards on reads and edits', byDefault: 'on' },
  'hooks.exec-review': { doc: 'privileged commands run on review (`teamrig exec`)', byDefault: 'on' },
  'hooks.readonly-allow': { doc: 'read-only commands run without a prompt', byDefault: 'on' },
  'hooks.ask-refuse': { doc: 'refusing a question to the person when asks are off', byDefault: 'on' },
  'hooks.permission-refuse': { doc: 'refusing a permission prompt when asks are off', byDefault: 'on' },
  'hooks.output-redact': { doc: 'redacting a secret in tool output', byDefault: 'on' },
  'hooks.prompt-secret': { doc: 'stopping a secret pasted in a prompt', byDefault: 'on' },
  'hooks.tool-failure': { doc: 'the status at a tool call end and the missing-command hint', byDefault: 'on' },
  'permissions.deny-lines': { doc: 'the permission deny lines, their doctor checks and trim', byDefault: 'on' },
  'permissions.auto-mode-routes': { doc: 'the push and deploy routes granted to auto mode', byDefault: 'on' },
  'sessions.open': { doc: 'opening a tab on its model, effort and name', byDefault: 'on' },
  'sessions.resume': { doc: 'resuming a session, and restoring it after a reboot', byDefault: 'on' },
  'sessions.identity': { doc: "the session's own id in the CLI", byDefault: 'on' },
  'sessions.wake': { doc: 'waking an idle session', byDefault: 'on' },
  'sessions.turn-end': { doc: 'the checks and metering at a turn end', byDefault: 'on' },
  'sessions.process': { doc: "finding the session's process", byDefault: 'on' },
  'sessions.in-tab': { doc: 'the in-tab command, bands, toasts and the refresh inside a turn', byDefault: 'on' },
  'sessions.carry': { doc: 'crons, scheduled wakes, the plan and the scratchpad carried over a refresh', byDefault: 'on' },
  'sessions.effort-writeback': { doc: 'a typed effort level written back to the session', byDefault: 'on' },
  'tabs.title-status': { doc: 'tab titles and status circles', byDefault: 'on' },
  'tabs.waiting-state': { doc: "the tab's waiting-on-a-decision state", byDefault: 'on' },
  'wake.api-retry': { doc: 'sending a turn again after an API error', byDefault: 'on' },
  'skills.plugin': { doc: 'the plugin skills', byDefault: 'on' },
  'skills.team': { doc: 'team and session skills', byDefault: 'on' },
  'skills.session-listing': { doc: "a session's own skill listing", byDefault: 'on' },
  'helpers.start-rules': { doc: 'helpers, and the rules at their start', byDefault: 'on' },
  'helpers.agent-types': { doc: "teamrig's agent types", byDefault: 'on' },
  'plugin.hooks-file': { doc: "teamrig's hooks file loads as shipped", byDefault: 'on' },
  'plugin.hook-trust': { doc: 'guards stay on across a teamrig update', byDefault: 'on' },
  'plugin.install-update': { doc: 'installing and updating teamrig, and reading its version', byDefault: 'on' },
  'plugin.cli-on-path': { doc: '`teamrig` on the path', byDefault: 'on' },
  'budget.transcripts': { doc: 'finding the transcripts', byDefault: 'on' },
  'budget.usage': { doc: 'the usage and weighted cost of each call', byDefault: 'on' },
  'budget.model-share': { doc: 'the share of each model and effort level', byDefault: 'on' },
  'budget.week-reading': { doc: 'the week reading and the pace line', byDefault: 'on' },
  'budget.five-hour': { doc: 'the five-hour forecast', byDefault: 'on' },
  'budget.status-line': { doc: "teamrig's status-line text", byDefault: 'on' },
  'budget.helper-weight': { doc: 'the weight of a helper', byDefault: 'on' },
  'os.windows-sessions': { doc: 'native Windows sessions and Windows Terminal tabs', byDefault: 'on' },
  'os.windows-hooks': { doc: 'hooks on Windows', byDefault: 'on' },
  'os.linux': { doc: 'sessions and hooks on Linux and macOS', byDefault: 'on' },
} as const satisfies Readonly<Record<string, HostFeature>>;

/** Every feature an outside tool's adapter must answer for; an id is `<kind>.<name>`. */
export const CONNECTOR_FEATURES = {
  'tracker.issue-import': { kind: 'tracker', doc: 'a task per open issue, kept in step with it (`issue sync`)', byDefault: 'on' },
  'tracker.accept-label': { kind: 'tracker', doc: "an outsider's issue is taken once one of the team's people labels it accepted", byDefault: 'on' },
  'tracker.watch': { kind: 'tracker', doc: 'a look for changes every few seconds, a sync only after one (`issue watch`)', byDefault: 'on' },
  'tracker.issue-open': { kind: 'tracker', doc: "opening a task's issue with its labels (`add --issue`, `issue migrate`)", byDefault: 'on' },
  'tracker.comment': { kind: 'tracker', doc: 'a comment on an issue (`issue comment`)', byDefault: 'on' },
  'tracker.edit-body': { kind: 'tracker', doc: "rewriting an issue's body (`issue edit-body`)", byDefault: 'on' },
  'tracker.close': { kind: 'tracker', doc: 'closing an issue as completed, not planned or duplicate (`issue close`)', byDefault: 'on' },
  'tracker.labels': { kind: 'tracker', doc: 'adding, removing and making labels (`issue label`)', byDefault: 'on' },
  'tracker.status-push': { kind: 'tracker', doc: 'a status label per active task, its owner as assignee (`issue push`)', byDefault: 'on' },
  'tracker.assign': { kind: 'tracker', doc: 'assigning and unassigning people (`issue assign`)', byDefault: 'on' },
  'tracker.claims': { kind: 'tracker', doc: "a commenter's take line assigns them, and an idle claim is taken off", byDefault: 'on' },
  'tracker.clocks': { kind: 'tracker', doc: 'the response clock: threads waiting on an answer from the team', byDefault: 'on' },
  'tracker.mentions': { kind: 'tracker', doc: "a post naming one of the team's people wakes their session", byDefault: 'on' },
  'tracker.follow': { kind: 'tracker', doc: 'a session hears the changes on an item it follows (`follow`)', byDefault: 'on' },
  'tracker.links': { kind: 'tracker', doc: 'parent and blocker links between issues (`issue links`)', byDefault: 'on' },
  'tracker.fields': { kind: 'tracker', doc: "a task's priority and type written to issue fields", byDefault: 'on' },
  'tracker.similar': { kind: 'tracker', doc: 'finding imported issues alike (`issue similar`)', byDefault: 'on' },
  'tracker.security-alert': { kind: 'tracker', doc: 'a security-labelled issue pages the lead', byDefault: 'on' },
  'tracker.stamp': { kind: 'tracker', doc: 'posted text ends with the made-with-teamrig footer', byDefault: 'on' },
  'tracker.hidden-mark': { kind: 'tracker', doc: 'a mark on an issue that its readers do not see', byDefault: 'on' },
  'codehost.pull-news': { kind: 'codehost', doc: 'opened, merged, conflicting, failing and reviewed pull requests reach their session', byDefault: 'on' },
  'codehost.ci-excerpt': { kind: 'codehost', doc: "the end of a failed CI job's log", byDefault: 'on' },
  'codehost.pr-conflicts': { kind: 'codehost', doc: 'the files a pull request conflicts on (`pr conflicts`)', byDefault: 'on' },
  'codehost.review-posts': { kind: 'codehost', doc: 'review comments and reviews in the mention scan', byDefault: 'on' },
  'codehost.linked-pulls': { kind: 'codehost', doc: 'how many open pull requests close an issue', byDefault: 'on' },
} as const satisfies Readonly<Record<string, ConnectorFeature>>;

export type HostFeatureId = keyof typeof HOST_FEATURES;
export type ConnectorFeatureId = keyof typeof CONNECTOR_FEATURES;
export type FeatureId = HostFeatureId | ConnectorFeatureId;

interface FeatureIdBySide {
  readonly host: HostFeatureId;
  readonly connector: ConnectorFeatureId;
}

/** The feature ids of one side. */
export type FeatureIdOf<Side extends FeatureSide> = FeatureIdBySide[Side];

export function isHostFeatureId(value: string): value is HostFeatureId {
  return Object.hasOwn(HOST_FEATURES, value);
}

export function isConnectorFeatureId(value: string): value is ConnectorFeatureId {
  return Object.hasOwn(CONNECTOR_FEATURES, value);
}

/** One registry row as a reader of either side takes it. */
export interface FeatureRow {
  readonly id: FeatureId;
  /** The part of the id before its dot: the heading its rows share on the parity page. */
  readonly group: string;
  readonly doc: string;
  readonly byDefault: Toggle;
}

function groupOf(id: string): string {
  return id.slice(0, id.indexOf('.'));
}

const HOST_ROWS: readonly FeatureRow[] = Object.keys(HOST_FEATURES)
  .filter(isHostFeatureId)
  .map((id) => ({ id, group: groupOf(id), doc: HOST_FEATURES[id].doc, byDefault: HOST_FEATURES[id].byDefault }));

const CONNECTOR_ROWS: readonly FeatureRow[] = Object.keys(CONNECTOR_FEATURES)
  .filter(isConnectorFeatureId)
  .map((id) => ({ id, group: CONNECTOR_FEATURES[id].kind, doc: CONNECTOR_FEATURES[id].doc, byDefault: CONNECTOR_FEATURES[id].byDefault }));

/** The rows of one side, in registry order. */
export function featuresOf(side: FeatureSide): readonly FeatureRow[] {
  return side === 'host' ? HOST_ROWS : CONNECTOR_ROWS;
}
