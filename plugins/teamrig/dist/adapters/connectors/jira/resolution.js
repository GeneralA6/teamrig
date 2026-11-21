/**
 * Why a Jira issue closed, both ways. Jira says it by a resolution (and some workflows by the closed status itself),
 * a name each site may change; the port says it by one of three reasons. A site's name is matched against what Jira's
 * own templates call each reason, its case aside. A name on none of these lists stands for no reason.
 */
const REASONS = ['completed', 'not-planned', 'duplicate'];
/** The names each reason goes by on a Jira site, in lowercase. */
const REASON_NAMES = {
    completed: ['done', 'fixed', 'resolved', 'completed'],
    'not-planned': ["won't do", "won't fix", 'declined', 'rejected', 'cancelled', 'canceled', 'cannot reproduce', 'incomplete', 'obsolete', 'invalid', 'not a bug'],
    duplicate: ['duplicate'],
};
/** Each reason as HostIssue.stateReason holds it. */
const REASON_WORD = { completed: 'COMPLETED', 'not-planned': 'NOT_PLANNED', duplicate: 'DUPLICATE' };
/** A name as it is matched: its case and outer blanks aside, a typographic apostrophe as a typed one. */
function plain(name) {
    return name.trim().toLowerCase().replace(/[‘’]/gu, "'");
}
/** The reason a resolution or a closed status named `name` stands for, or undefined when it stands for none. */
export function reasonOf(name) {
    const wanted = plain(name);
    return REASONS.find((reason) => REASON_NAMES[reason].includes(wanted));
}
/**
 * Why a closed issue closed, as HostIssue.stateReason holds it: the port's word for a resolution that stands for a
 * reason, else the resolution's own name, which core reads as done.
 */
export function stateReasonOf(resolution) {
    const reason = reasonOf(resolution);
    return reason === undefined ? resolution : REASON_WORD[reason];
}
