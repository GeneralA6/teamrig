import type { Role } from '../config/roster.ts';
import type { HireRecord, RetireRecord } from '../hiring/record.ts';
import type { NeedKind } from '../tabs/need-kind.ts';
import type { TabState } from '../tabs/state.ts';
import { ServedText, type Cut, type SecretShapes } from './text.ts';

/**
 * What a session is doing, as far as its tab tells: at work, free, or stopped on something only a person answers. A
 * minor may add a state, so a reader passes over one it does not know.
 */
export type SessionState = 'busy' | 'idle' | 'asking';

/**
 * The tab's own states as the three served ones. Compacting is work the session cannot be interrupted in; a wait, a
 * decision and an error each stop it until a person acts.
 */
const STATES: Readonly<Record<TabState, SessionState>> = {
  working: 'busy',
  compacting: 'busy',
  ready: 'idle',
  waiting: 'asking',
  decision: 'asking',
  error: 'asking',
};

/** The program a session runs in. */
export interface ServedHost {
  readonly id: string;
  readonly name: string;
}

/** The model and effort a session starts on; null for a key left to the host's own default. */
export interface ServedLaunch {
  readonly model: string | null;
  readonly effort: string | null;
  /** The two in words, for a line a person reads. */
  readonly text: string;
}

/** The hire a session is on the team by. */
export interface ServedHire {
  readonly at: string;
  /** The session that hired it. */
  readonly by: string;
  /** The job it was hired for. */
  readonly scope: string;
  readonly reason: string;
  /** The day the hire is reviewed, `YYYY-MM-DD` (UTC). */
  readonly reviewBy: string;
  readonly approvedBy: string | null;
  /** The start of the burst it was hired for, after which it is due to retire; null for a hire outside a burst. */
  readonly burst: string | null;
}

/** A session's retirement. The handover it left is a path on the team's disk and is not served. */
export interface ServedRetire {
  readonly at: string;
  readonly by: string;
  readonly reason: string;
  /** The session its open tasks went to. */
  readonly heir: string | null;
}

/** What a session asks a person: the kind and the task it names, never the ask's words, which come from a tool's input. */
export interface ServedAsk {
  readonly kind: NeedKind;
  readonly task: string | null;
}

/** One session of the tree, on a team now or retired from it. */
export interface ServedSession {
  readonly team: string;
  readonly id: string;
  readonly name: string;
  readonly formerNames: readonly string[];
  readonly roles: readonly Role[];
  /** Its direct leader, by id; null for the team's lead and for a retired session. */
  readonly leader: string | null;
  /** The leaders above it, nearest first, ending at the team's lead. */
  readonly ledBy: readonly string[];
  /** How many sessions it leads directly. */
  readonly leads: number;
  /** False for a session retired and not hired again: it is on no team, and only its names and `retire` are set. */
  readonly active: boolean;
  readonly launch: ServedLaunch | null;
  /** Null for a session the team's config named with no hire. */
  readonly hire: ServedHire | null;
  /** The retirement a hired session came back from; null for a first hire. */
  readonly rehiredFrom: ServedRetire | null;
  readonly retire: ServedRetire | null;
  /** How many inbox lines it has not read; null when it never read its inbox, and then every line counts as unread. */
  readonly unread: number | null;
  /** Null when it has no tab open, or its tab file cannot be read. */
  readonly state: SessionState | null;
  readonly ask: ServedAsk | null;
  /** When its tab took this state. */
  readonly since: string | null;
  readonly host: ServedHost | null;
  /** The host's own id of the conversation the session last started in: opaque, and a proof of nothing. */
  readonly conversation: string | null;
}

/** One team of the tree, and how many sessions it holds and has retired. */
export interface ServedTeam {
  readonly id: string;
  /** The team above it; null for the tree's root. */
  readonly parent: string | null;
  readonly active: number;
  readonly retired: number;
}

/** A session by its team and id. */
export interface SessionPlace {
  readonly team: string;
  readonly session: string;
}

/** A team folder whose sessions could not be served, and why. */
export interface TeamFailure {
  readonly team: string;
  readonly reason: string;
}

/** The `sessions` document's own fields. */
export interface SessionsBody {
  /** The session the asked conversation runs in; null when none was asked, or no session of the tree holds it. */
  readonly self: SessionPlace | null;
  readonly teams: readonly ServedTeam[];
  readonly sessions: readonly ServedSession[];
  readonly failures: readonly TeamFailure[];
  readonly cuts: readonly Cut[];
}

/**
 * What the document takes of a session's tab record (`TabNeed`, src/tabs/need.ts, which fits it as it is). The ask's
 * words are no part of it, and the record's own file is not imported: it reads the disk, which this folder may not.
 */
export interface TabInput {
  readonly state: TabState;
  /** What the tab asks; null while it asks nothing. */
  readonly kind: NeedKind | null;
  readonly task: string | null;
  /** When the tab took this state, an ISO time. */
  readonly since: string;
}

/** A session on a team, with what the team's files hold of it. */
export interface MemberInput {
  readonly id: string;
  readonly name: string;
  readonly formerNames: readonly string[];
  readonly roles: readonly Role[];
  readonly leader: string | null;
  readonly ledBy: readonly string[];
  readonly leads: number;
  readonly launch: ServedLaunch;
  readonly hire: HireRecord | null;
  readonly rehiredFrom: RetireRecord | null;
  readonly unread: number | null;
  /** Its tab file's record; null with no file, or one that cannot be read. */
  readonly tab: TabInput | null;
  readonly host: ServedHost;
  readonly conversation: string | null;
}

/** A session retired from a team and not hired again. */
export interface RetiredInput {
  readonly id: string;
  readonly name: string;
  readonly formerNames: readonly string[];
  readonly retire: RetireRecord;
}

/** One team of the tree: its sessions in the config's order, then the retired ones. */
export interface TeamInput {
  readonly id: string;
  readonly parent: string | null;
  readonly members: readonly MemberInput[];
  readonly retired: readonly RetiredInput[];
}

/** What the `sessions` document is built from. */
export interface SessionsInput {
  readonly self: SessionPlace | null;
  /** The tree's teams, in the order they are served. */
  readonly teams: readonly TeamInput[];
  readonly failures: readonly TeamFailure[];
  readonly shapes: SecretShapes;
}

function isoOf(at: number): string {
  return new Date(at).toISOString();
}

/** A record's id for the document's cuts: a session's id alone is not one, since two teams may each have a `lead`. */
function recordOf(team: string, id: string): string {
  return `${team}/${id}`;
}

function hireOf(served: ServedText, record: string, hire: HireRecord): ServedHire {
  return {
    at: isoOf(hire.at),
    by: hire.by,
    scope: served.plain(record, 'hire.scope', hire.scope),
    reason: served.plain(record, 'hire.reason', hire.reason),
    reviewBy: hire.reviewBy,
    approvedBy: hire.approvedBy ?? null,
    burst: hire.burst === undefined ? null : isoOf(hire.burst),
  };
}

function retireOf(served: ServedText, record: string, field: 'retire' | 'rehiredFrom', retire: RetireRecord): ServedRetire {
  return { at: isoOf(retire.at), by: retire.by, reason: served.plain(record, `${field}.reason`, retire.reason), heir: retire.heir ?? null };
}

function memberOf(served: ServedText, team: string, member: MemberInput): ServedSession {
  const record = recordOf(team, member.id);
  const { tab } = member;
  return {
    team,
    id: member.id,
    name: member.name,
    formerNames: member.formerNames,
    roles: member.roles,
    leader: member.leader,
    ledBy: member.ledBy,
    leads: member.leads,
    active: true,
    launch: member.launch,
    hire: member.hire === null ? null : hireOf(served, record, member.hire),
    rehiredFrom: member.rehiredFrom === null ? null : retireOf(served, record, 'rehiredFrom', member.rehiredFrom),
    retire: null,
    unread: member.unread,
    state: tab === null ? null : STATES[tab.state],
    ask: tab === null || tab.kind === null ? null : { kind: tab.kind, task: tab.task },
    since: tab?.since ?? null,
    host: member.host,
    conversation: member.conversation,
  };
}

function retiredOf(served: ServedText, team: string, retired: RetiredInput): ServedSession {
  return {
    team,
    id: retired.id,
    name: retired.name,
    formerNames: retired.formerNames,
    roles: [],
    leader: null,
    ledBy: [],
    leads: 0,
    active: false,
    launch: null,
    hire: null,
    rehiredFrom: null,
    retire: retireOf(served, recordOf(team, retired.id), 'retire', retired.retire),
    unread: null,
    state: null,
    ask: null,
    since: null,
    host: null,
    conversation: null,
  };
}

/**
 * The `sessions` document's body: every team handed in, in that order, and under each its sessions, then the ones it
 * retired. It makes its own `ServedText`, so `cuts` lists this document's cuts and no other's; a cut names its
 * session as `<team>/<id>`.
 */
export function sessionsBody(input: SessionsInput): SessionsBody {
  const served = new ServedText(input.shapes);
  const sessions = input.teams.flatMap((team) => [
    ...team.members.map((member) => memberOf(served, team.id, member)),
    ...team.retired.map((retired) => retiredOf(served, team.id, retired)),
  ]);
  const teams = input.teams.map((team) => ({ id: team.id, parent: team.parent, active: team.members.length, retired: team.retired.length }));
  return { self: input.self, teams, sessions, failures: input.failures, cuts: served.cuts };
}
