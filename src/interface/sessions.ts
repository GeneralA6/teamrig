import type { Role } from '../config/roster.ts';
import type { HireRecord, RetireRecord } from '../hiring/record.ts';
import { TASK_ID } from '../register/model.ts';
import type { NeedKind } from '../tabs/need-kind.ts';
import type { TabState } from '../tabs/state.ts';
import { ServedText, type Cut, type SecretShapes } from './text.ts';

/**
 * Where a team stands to the caller's: its own, one above it, or any other team of the tree, beside or below it.
 * Every team of a tree sees who is on the others, as `teamrig who` shows it, but a team's own words (a hire's and a
 * retirement's, the launch in words) go only to itself and the teams below it, so they are served for `own` and
 * `above` alone; a conversation id is served for `own` alone.
 */
export type TeamReach = 'own' | 'above' | 'other';

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
  /** The two in words, for a line a person reads; null for a team beside or below the caller's. */
  readonly text: string | null;
}

/** The hire a session is on the team by. Its `scope` and `reason` are null for a team beside or below the caller's. */
export interface ServedHire {
  readonly at: string;
  /** The session that hired it. */
  readonly by: string;
  /** The job it was hired for. */
  readonly scope: string | null;
  readonly reason: string | null;
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
  /** Null for a team beside or below the caller's. */
  readonly reason: string | null;
  /** The session its open tasks went to. */
  readonly heir: string | null;
}

/** What a session asks a person: the kind and the task it names, never the ask's words, which come from a tool's input. */
export interface ServedAsk {
  readonly kind: NeedKind;
  /** Null when the ask names no task, or its tab file holds something else than a task's id there. */
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
  /**
   * The host's own id of the conversation the session last started in: opaque, and a proof of nothing. Served for
   * the caller's own team only; null for every other team's sessions.
   */
  readonly conversation: string | null;
}

/**
 * A team's own part of the account's week, as its budget hooks last wrote it, in percent of the account's week; a
 * child team's part is its own row's, so a team's week with its children's is the sum over the rows of one week.
 */
export interface ServedWeek {
  readonly usedPct: number;
  readonly plannedPct: number;
  /** The whole account's use of its week, every team's. */
  readonly accountUsedPct: number;
  /** When the week it speaks of resets: a week already reset is no longer running, whatever the numbers say. */
  readonly resetsAt: string;
  /** Where the week's use counts from, when that is after the account's last reset; null when the hooks named none. */
  readonly start: string | null;
  /** When the hooks wrote it. */
  readonly at: string;
}

/** One team of the tree, and how many sessions it holds and has retired. */
export interface ServedTeam {
  readonly id: string;
  /** The team above it; null for the tree's root. */
  readonly parent: string | null;
  readonly active: number;
  readonly retired: number;
  /** Since 1.8: its own part of the account's week; null when its hooks wrote none this teamrig can read. */
  readonly week: ServedWeek | null;
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

/** A session's launch as its team's config holds it: the model and effort the config checked, and the two in words. */
export interface LaunchInput {
  readonly model: string | null;
  readonly effort: string | null;
  readonly text: string;
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
  readonly launch: LaunchInput;
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
  readonly reach: TeamReach;
  readonly members: readonly MemberInput[];
  readonly retired: readonly RetiredInput[];
  readonly week: ServedWeek | null;
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

/**
 * One team's texts on their way out: a session's names for every team, the team's own words only within reach. A
 * text out of reach is never scanned, so it adds no cut.
 */
class TeamText {
  private readonly served: ServedText;
  private readonly team: TeamInput;

  constructor(served: ServedText, team: TeamInput) {
    this.served = served;
    this.team = team;
  }

  /** A session's name: every team of the tree may read it, and it is scanned like any text a person typed. */
  name(id: string, field: string, name: string): string {
    return this.served.plain(recordOf(this.team.id, id), field, name);
  }

  /** The team's own words about session `id`; null for a team beside or below the caller's. */
  words(id: string, field: string, text: string): string | null {
    return this.team.reach === 'other' ? null : this.served.plain(recordOf(this.team.id, id), field, text);
  }
}

function namesOf(text: TeamText, session: { readonly id: string; readonly name: string; readonly formerNames: readonly string[] }): Pick<ServedSession, 'name' | 'formerNames'> {
  return {
    name: text.name(session.id, 'name', session.name),
    formerNames: session.formerNames.map((former) => text.name(session.id, 'formerNames', former)),
  };
}

function hireOf(text: TeamText, id: string, hire: HireRecord): ServedHire {
  return {
    at: isoOf(hire.at),
    by: hire.by,
    scope: text.words(id, 'hire.scope', hire.scope),
    reason: text.words(id, 'hire.reason', hire.reason),
    reviewBy: hire.reviewBy,
    approvedBy: hire.approvedBy ?? null,
    burst: hire.burst === undefined ? null : isoOf(hire.burst),
  };
}

function retireOf(text: TeamText, id: string, field: 'retire' | 'rehiredFrom', retire: RetireRecord): ServedRetire {
  return { at: isoOf(retire.at), by: retire.by, reason: text.words(id, `${field}.reason`, retire.reason), heir: retire.heir ?? null };
}

/** The ask of a tab that asks something. Its task is read from a file any process may have written, so only a task's id passes. */
function askOf(tab: TabInput | null): ServedAsk | null {
  if (tab === null || tab.kind === null) {
    return null;
  }
  return { kind: tab.kind, task: tab.task !== null && TASK_ID.test(tab.task) ? tab.task : null };
}

function memberOf(text: TeamText, team: TeamInput, member: MemberInput): ServedSession {
  const { tab, launch } = member;
  return {
    team: team.id,
    id: member.id,
    ...namesOf(text, member),
    roles: member.roles,
    leader: member.leader,
    ledBy: member.ledBy,
    leads: member.leads,
    active: true,
    launch: { model: launch.model, effort: launch.effort, text: text.words(member.id, 'launch.text', launch.text) },
    hire: member.hire === null ? null : hireOf(text, member.id, member.hire),
    rehiredFrom: member.rehiredFrom === null ? null : retireOf(text, member.id, 'rehiredFrom', member.rehiredFrom),
    retire: null,
    unread: member.unread,
    state: tab === null ? null : STATES[tab.state],
    ask: askOf(tab),
    since: tab?.since ?? null,
    host: member.host,
    conversation: team.reach === 'own' ? member.conversation : null,
  };
}

function retiredOf(text: TeamText, team: TeamInput, retired: RetiredInput): ServedSession {
  return {
    team: team.id,
    id: retired.id,
    ...namesOf(text, retired),
    roles: [],
    leader: null,
    ledBy: [],
    leads: 0,
    active: false,
    launch: null,
    hire: null,
    rehiredFrom: null,
    retire: retireOf(text, retired.id, 'retire', retired.retire),
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
  const sessions = input.teams.flatMap((team) => {
    const text = new TeamText(served, team);
    return [...team.members.map((member) => memberOf(text, team, member)), ...team.retired.map((retired) => retiredOf(text, team, retired))];
  });
  const teams = input.teams.map((team) => ({ id: team.id, parent: team.parent, active: team.members.length, retired: team.retired.length, week: team.week }));
  return { self: input.self, teams, sessions, failures: input.failures, cuts: served.cuts };
}
