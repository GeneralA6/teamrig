import type { HostEnd, IssueTarget } from './host.ts';

/**
 * Issue fields and types (T3406): typed values a tracker keeps on an issue beside its labels, such as GitHub's
 * Priority, Start date, Target date and number fields, and its issue types (Task, Bug, Feature). A tracker that has
 * them gives an IssueFields capability; one without leaves it out, and the push skips the fields there and says so.
 */

/** What a field holds, as the push writes it: a day (`YYYY-MM-DD`), a number, one option by name, or a line of text. */
export type FieldKind = 'date' | 'number' | 'single-select' | 'text';

/** One field a repository's issues may carry: its name, its kind, the host's id a write names, and its options. */
export interface HostField {
  readonly name: string;
  readonly kind: FieldKind;
  /** The host's id of the field: a whole number from 1 up, the one a value write names. */
  readonly id: number;
  /** The option names of a single-select field, in the host's order; empty for any other kind. */
  readonly options: readonly string[];
}

/** A field's value: a day, an option name or text as a string, a number as a number. */
export type FieldValue = string | number;

/** One open issue as the fields read found it: its type, if any, and each field it has a value for, by field name. */
export interface FieldedIssue {
  readonly number: number;
  readonly type: string | undefined;
  /** Keyed by the field's name in lowercase. */
  readonly values: ReadonlyMap<string, FieldValue>;
}

/**
 * What the fields read of one repository found: the fields and the enabled issue types it has, and its open issues
 * with their values; `none` when it has neither fields nor types to write; or why it could not be read.
 */
export type HostFieldRead =
  | {
      readonly kind: 'read';
      readonly fields: readonly HostField[];
      readonly types: readonly string[];
      readonly issues: readonly FieldedIssue[];
      readonly notes: readonly string[];
    }
  | { readonly kind: 'none'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

/** A tracker's issue fields and types: one read of a repository, and one write per value or type. Each ends in a result and never throws. */
export interface IssueFields {
  /** The fields and types of `repo` and the values its open issues hold. */
  read(repo: string): Promise<HostFieldRead>;
  /** Sets `field` of the issue to `value`, which is of the field's kind. */
  setField(target: IssueTarget, field: HostField, value: FieldValue): Promise<HostEnd>;
  /** Sets the issue's type to `type`, one of the repository's enabled types, spelled as the read gave it. */
  setType(target: IssueTarget, type: string): Promise<HostEnd>;
}
