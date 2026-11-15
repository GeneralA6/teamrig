/**
 * The commits a register note names (T3044): runs of 7 to 40 lowercase hex digits, the same runs `ship.ts merge`
 * reads an approval's note for (tools/ship/approval.ts), so the register and the merge agree on which head an
 * approval names.
 */
const COMMIT_RUN = /\b[0-9a-f]{7,40}\b/g;

/** The commit ids `text` names, in order; none for no text. */
export function commitsNamed(text: string | null): readonly string[] {
  return text?.match(COMMIT_RUN) ?? [];
}

/**
 * Whether `note` names a commit that `approvedNote` does not, either one abbreviated: a head the approval never saw.
 * A note naming any other commit (say main's) counts too, which only asks for the approval again.
 */
export function namesUnapprovedCommit(note: string | null, approvedNote: string | null): boolean {
  const approved = commitsNamed(approvedNote);
  return commitsNamed(note).some((sha) => !approved.some((named) => named.startsWith(sha) || sha.startsWith(named)));
}
