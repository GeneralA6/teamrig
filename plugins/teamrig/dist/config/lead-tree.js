/**
 * The team's lead tree (T781): `roles.lead` at the top, and each sub-lead in `leads` over the sessions it lists. A
 * session's leader is the sub-lead that lists it, else the lead; the lead has none. The parser keeps the tree whole (one
 * leader per session, the lead never a member, no cycles), so every walk here ends at the lead.
 */
export class LeadTree {
    lead;
    sessions;
    /** Each listed member to the sub-lead that leads it. */
    listedLeader;
    subLeads;
    constructor(config) {
        this.lead = config.roles.lead;
        this.sessions = config.sessions;
        this.subLeads = new Set(Object.keys(config.leads));
        this.listedLeader = new Map(Object.entries(config.leads).flatMap(([subLead, members]) => members.map((member) => [member, subLead])));
    }
    /** The session's direct leader: its sub-lead, else the lead; undefined for the lead and for an id not on the team. */
    leaderOf(id) {
        if (id === this.lead || !this.sessions.includes(id)) {
            return undefined;
        }
        return this.listedLeader.get(id) ?? this.lead;
    }
    /** The leaders above the session, nearest first, ending at the lead; empty for the lead itself. */
    chainOf(id) {
        const chain = [];
        // The parser refuses cycles; the seen set only keeps a hand-built config from looping.
        const seen = new Set([id]);
        for (let leader = this.leaderOf(id); leader !== undefined && !seen.has(leader); leader = this.leaderOf(leader)) {
            chain.push(leader);
            seen.add(leader);
        }
        return chain;
    }
    /**
     * Whose decision or approval a session's task may wait on, besides the human owner: its leaders, nearest first, so
     * the lead always; the lead's own task waits on the lead.
     */
    approversOf(id) {
        const chain = this.chainOf(id);
        return chain.length === 0 ? [this.lead] : chain;
    }
    /** The sessions the leader leads directly, in config order: for the lead, every session no sub-lead lists. */
    membersOf(leader) {
        return this.sessions.filter((id) => this.leaderOf(id) === leader);
    }
    /** Every session under the leader, at any depth, in config order. */
    groupOf(leader) {
        return this.sessions.filter((id) => this.chainOf(id).includes(leader));
    }
    /** Whether the session leads anyone: the lead, or a sub-lead. */
    isLeader(id) {
        return id === this.lead || this.subLeads.has(id);
    }
    /** Whether `leader` is above `id` in the tree, at any depth. */
    leads(leader, id) {
        return this.chainOf(id).includes(leader);
    }
}
