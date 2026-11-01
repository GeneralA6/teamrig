/**
 * The author ties GitHub gives the repository's owner, its organization's members and its collaborators. Every other
 * one (`CONTRIBUTOR` for any merged pull request, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `MANNEQUIN`, `NONE`, a
 * deleted author) waits for the accept label.
 */
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
/** The account kind of a person on GitHub; a `Bot` (an app or a workflow) or an `Organization` never accepts. */
const PERSON = 'User';
/**
 * How far the sync takes `issue`'s text. Only someone with triage rights can label an issue, so a label needs no
 * rights lookup; the two other ways a label lands are refused by its actor: an issue template applies it with the
 * author as actor, a workflow or app with a `Bot` one. An edit of the title or body at or after the accept undoes it
 * (the person who accepted read the older text), until someone adds the label again.
 */
export function issueTrust(issue, acceptLabel) {
    if (TRUSTED_ASSOCIATIONS.has(issue.authorAssociation.toUpperCase())) {
        return 'trusted';
    }
    if (!issue.labels.some((label) => sameLabel(label, acceptLabel))) {
        return 'untrusted';
    }
    const accept = issue.labelEvents.filter((event) => sameLabel(event.label, acceptLabel)).at(-1);
    return accept !== undefined && byAnotherPerson(accept, issue.author) && !editedSince(issue, accept.at) ? 'accepted' : 'untrusted';
}
/** GitHub matches label names without case. */
function sameLabel(name, acceptLabel) {
    return name.trim().toLowerCase() === acceptLabel.trim().toLowerCase();
}
/** A person's account GitHub still has, other than the issue's author. */
function byAnotherPerson(event, author) {
    return event.actorKind === PERSON && event.actor !== '' && event.actor.toLowerCase() !== author.toLowerCase();
}
/** Whether the body or the title changed at or after `at`: an edit in the same second as the accept counts as after it. */
function editedSince(issue, at) {
    const accepted = Date.parse(at);
    return [issue.lastEditedAt, issue.renamedAt].some((edit) => edit !== undefined && Date.parse(edit) >= accepted);
}
