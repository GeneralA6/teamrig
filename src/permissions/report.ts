import { countOf, formatCounts, mergeCounts, type AllowTrim } from './allow-rules.ts';
import { rewritesOf, type FilePlan, type TrimWrite, type WideAllow } from './trim.ts';

/**
 * The lines `teamrig permissions trim`, doctor and the lead's session start print about allow rules: a file's path and
 * its rules counted by class, never a rule's text, since a rule can hold a value (a URI with a password, a token).
 */

function keptText(trim: AllowTrim): string {
  const other = countOf(trim.keptOther);
  return `${trim.listed.length} on the keep-list${other === 0 ? '' : `, ${other} more (${formatCounts(trim.keptOther)})`}`;
}

/** One file's preview line, or undefined for a file with nothing to tell: none there, or no allow rule in it. */
export function planLine(plan: FilePlan): string | undefined {
  if (plan.kind === 'absent') {
    return undefined;
  }
  const path = plan.file.path;
  if (plan.kind === 'unreadable') {
    return `  ${path}: left as it is, ${plan.why}`;
  }
  const { trim, total } = plan;
  const removed = countOf(trim.removed);
  if (total === 0) {
    return undefined;
  }
  if (removed === 0) {
    return `  ${path}: ${total} allow rules, none to remove; keeps ${keptText(trim)}`;
  }
  if (plan.next === undefined) {
    return `  ${path}: ${total} allow rules, ${removed} to remove (${formatCounts(trim.removed)}); it is committed with its repo, so change it by a commit`;
  }
  return `  ${path}: ${total} allow rules -> ${trim.after.length}, remove ${removed} (${formatCounts(trim.removed)}); keeps ${keptText(trim)}`;
}

/** The sum of what the trim rewrites. */
export function totalLine(plans: readonly FilePlan[]): string {
  const rewrites = rewritesOf(plans);
  const before = rewrites.reduce((sum, plan) => sum + plan.total, 0);
  const after = rewrites.reduce((sum, plan) => sum + plan.trim.after.length, 0);
  const removed = formatCounts(mergeCounts(rewrites.map((plan) => plan.trim.removed)));
  return `TOTAL ${rewrites.length} file(s) to rewrite: ${before} allow rules -> ${after} (remove ${before - after}: ${removed})`;
}

/** One rewrite's line. */
export function writeLine(write: TrimWrite): string {
  const { plan } = write;
  switch (write.result) {
    case 'wrote':
      return `  ${plan.file.path}: ${plan.total} allow rules -> ${plan.trim.after.length}, removed ${formatCounts(plan.trim.removed)}`;
    case 'changed-since-read':
      return `  ${plan.file.path}: changed since it was read, so left as it is; run the trim again`;
    case 'not-verified':
      return `  ${plan.file.path}: FAILED the read-back check after the write; its old text is at ${write.backup}`;
  }
}

/** The flag, or undefined when no rule off the keep-list approves a whole tool or program or holds a credential. */
export function wideAllowText(wide: WideAllow): string | undefined {
  const count = countOf(wide.counts);
  if (count === 0) {
    return undefined;
  }
  return (
    `${count} local allow rule(s) in ${wide.files} settings file(s) approve a whole tool or program, so auto mode's classifier never sees those calls, ` +
    `or hold a credential saved with an approved command (${formatCounts(wide.counts)}); \`teamrig permissions trim\` previews their removal, and the owner runs it with --yes`
  );
}
