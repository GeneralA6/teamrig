/**
 * The commits a register note names (T3044): runs of 7 to 40 hex digits, the runs `ship.ts merge` reads an approval's
 * note for (tools/ship/approval.ts), in either case here (T3094): a head written in upper case names a commit as well.
 */
const COMMIT_RUN = /\b[0-9a-f]{7,40}\b/gi;

/** The commit ids `text` names, in order and in lower case; none for no text. */
export function commitsNamed(text: string | null): readonly string[] {
  return (text?.match(COMMIT_RUN) ?? []).map((sha) => sha.toLowerCase());
}

/**
 * Whether `note` names a commit that `approvedNote` does not, either one abbreviated: a head the approval never saw.
 * A note naming any other commit (say main's) counts too, which only asks for the approval again.
 */
export function namesUnapprovedCommit(note: string | null, approvedNote: string | null): boolean {
  const approved = commitsNamed(approvedNote);
  return commitsNamed(note).some((sha) => !approved.some((named) => named.startsWith(sha) || sha.startsWith(named)));
}

/**
 * Whether `note` names the head `approvedNote` approved, and no other commit (T3094): at least one commit,
 * each one the approval names, and one written out at least as fully as the approval writes it. A note naming no
 * commit, or the head only by a shorter prefix, a ref, a pull request or "the new head", is no proof the head is
 * unchanged.
 */
export function namesApprovedHead(note: string | null, approvedNote: string | null): boolean {
  const approved = commitsNamed(approvedNote);
  const named = commitsNamed(note);
  return named.length > 0 && !namesUnapprovedCommit(note, approvedNote) && named.some((sha) => approved.some((head) => sha.startsWith(head)));
}
