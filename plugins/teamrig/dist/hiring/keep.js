import { LeadTree } from "../config/lead-tree.js";
import { checkedReviewDay } from "./plan.js";
/** The keep to log for a hired session, or why not. */
export function planKeep(config, active, request) {
    if (request.by !== config.roles.lead && !new LeadTree(config).leads(request.by, request.id)) {
        return { ok: false, problem: 'only a lead over the session keeps it (the lead, or its sub-lead): the leader decides which workers the team needs' };
    }
    const hire = active.find((record) => record.session === request.id);
    if (hire === undefined) {
        return { ok: false, problem: `${request.id} is set up with the team, not hired: it has no review day to keep` };
    }
    if (request.reason.trim() === '') {
        return { ok: false, problem: 'a keep needs why the team still needs it (--reason)' };
    }
    const reviewBy = checkedReviewDay(request.reviewBy, request.now);
    if (!reviewBy.ok) {
        return reviewBy;
    }
    const keep = { kind: 'keep', session: request.id, reviewBy: reviewBy.value, reason: request.reason.trim(), by: request.by, at: request.now };
    return { ok: true, value: { keep, hire } };
}
