import { TASK_ID } from "../register/model.js";
import { ServedText } from "./text.js";
/**
 * The tab's own states as the three served ones. Compacting is work the session cannot be interrupted in; a wait, a
 * decision and an error each stop it until a person acts.
 */
const STATES = {
    working: 'busy',
    compacting: 'busy',
    ready: 'idle',
    waiting: 'asking',
    decision: 'asking',
    error: 'asking',
};
function isoOf(at) {
    return new Date(at).toISOString();
}
/** A record's id for the document's cuts: a session's id alone is not one, since two teams may each have a `lead`. */
function recordOf(team, id) {
    return `${team}/${id}`;
}
/**
 * One team's texts on their way out: a session's names for every team, the team's own words only within reach. A
 * text out of reach is never scanned, so it adds no cut.
 */
class TeamText {
    served;
    team;
    constructor(served, team) {
        this.served = served;
        this.team = team;
    }
    /** A session's name: every team of the tree may read it, and it is scanned like any text a person typed. */
    name(id, field, name) {
        return this.served.plain(recordOf(this.team.id, id), field, name);
    }
    /** The team's own words about session `id`; null for a team beside or below the caller's. */
    words(id, field, text) {
        return this.team.reach === 'other' ? null : this.served.plain(recordOf(this.team.id, id), field, text);
    }
}
function namesOf(text, session) {
    return {
        name: text.name(session.id, 'name', session.name),
        formerNames: session.formerNames.map((former) => text.name(session.id, 'formerNames', former)),
    };
}
function hireOf(text, id, hire) {
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
function retireOf(text, id, field, retire) {
    return { at: isoOf(retire.at), by: retire.by, reason: text.words(id, `${field}.reason`, retire.reason), heir: retire.heir ?? null };
}
/** The ask of a tab that asks something. Its task is read from a file any process may have written, so only a task's id passes. */
function askOf(tab) {
    if (tab === null || tab.kind === null) {
        return null;
    }
    return { kind: tab.kind, task: tab.task !== null && TASK_ID.test(tab.task) ? tab.task : null };
}
function memberOf(text, team, member) {
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
function retiredOf(text, team, retired) {
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
export function sessionsBody(input) {
    const served = new ServedText(input.shapes);
    const sessions = input.teams.flatMap((team) => {
        const text = new TeamText(served, team);
        return [...team.members.map((member) => memberOf(text, team, member)), ...team.retired.map((retired) => retiredOf(text, team, retired))];
    });
    const teams = input.teams.map((team) => ({ id: team.id, parent: team.parent, active: team.members.length, retired: team.retired.length }));
    return { self: input.self, teams, sessions, failures: input.failures, cuts: served.cuts };
}
