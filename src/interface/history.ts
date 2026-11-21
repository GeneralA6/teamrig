import type { CreateEvent, RegisterEvent, StatusEvent, TaskFields, UpdateEvent } from '../register/events.ts';
import type { Connector } from './connector.ts';
import { refOf, type ServedRef } from './ref.ts';
import { sourceOf, type ServedSource, type SourceNames } from './source.ts';
import { servedWait, type ServedWait } from './tasks.ts';
import { ServedText, type Cut, type MarkedText, type SecretShapes, type TextSource } from './text.ts';

/**
 * The fields a task is created with, as a create event serves them: the ones the `tasks` document serves of a
 * task, under the same names and in the same forms. A field the register holds beside them is not served until a
 * minor adds it here.
 */
export interface ServedFields {
  readonly title: MarkedText;
  readonly description: MarkedText | null;
  readonly owner: string;
  /** 1 is the most urgent. */
  readonly priority: number;
  /** Null when no one set it, which reads as a task. */
  readonly type: string | null;
  readonly critical: boolean;
  /** `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`, UTC; a bare day means its end. */
  readonly due: string | null;
  readonly source: ServedSource;
  readonly ref: ServedRef | null;
  readonly goals: readonly string[];
  readonly week: string | null;
  /** What the task still costs, in percent of the weekly usage limit. */
  readonly size: number | null;
  /** The leader who pinned it to the top of its owner's list. */
  readonly pin: string | null;
  readonly workClass: string | null;
  /** The tasks to finish before this one starts. */
  readonly after: readonly string[];
}

/** What every served event starts with: when it was written and the session that wrote it. */
interface ServedEventHead {
  readonly at: string;
  readonly by: string;
}

/** The task was added, with these fields. */
export interface ServedCreate extends ServedEventHead {
  readonly kind: 'create';
  readonly task: ServedFields;
}

/**
 * The task's status was set. What only some statuses write is null on an event that wrote none: `waits` and
 * `followups` are then null and not empty, since an empty list is itself something a change can say.
 */
export interface ServedStatusChange extends ServedEventHead {
  readonly kind: 'status';
  /** A plain string, not the register's own list: a minor may add a status. */
  readonly status: string;
  readonly note: string | null;
  readonly evidence: string | null;
  readonly skill: string | null;
  readonly proof: string | null;
  /** What a sighting shows once a done change runs live. */
  readonly watch: string | null;
  /** On a start, what shows the proof of the verifying tasks it needs exists. */
  readonly met: string | null;
  /** True on a start said to be a one-commit fix. */
  readonly oneCommit: boolean;
  readonly waits: readonly ServedWait[] | null;
  readonly followups: readonly string[] | null;
}

/**
 * Fields of the task were changed, or a leader answered what it waits on. `changes` holds only the fields this
 * event gave, each with its new value, so a field that is absent was left as it was and one that is null was
 * cleared.
 */
export interface ServedUpdate extends ServedEventHead {
  readonly kind: 'update';
  readonly changes: Partial<ServedFields>;
  readonly note: string | null;
  /** The lead's answer to the task's approval wait; a plain string, since a minor may add a verdict. */
  readonly verdict: string | null;
  /** The waits a put-off or a decision left the task with; null on every other update. */
  readonly waits: readonly ServedWait[] | null;
  /** True when the update records the owner's decision on the task's card, which its note says. */
  readonly decided: boolean;
}

/** The task went to another team of the tree; its later events are in that team's register. */
export interface ServedMoved extends ServedEventHead {
  readonly kind: 'moved';
  readonly to: string;
}

/** One event of a task's history. A minor may add a kind, so a reader passes over one it does not know. */
export type ServedEvent = ServedCreate | ServedStatusChange | ServedUpdate | ServedMoved;

/** The `history` document's own fields. */
export interface HistoryBody {
  /** The task asked for. */
  readonly task: string;
  /** Its events in the order they were written; none for an id the register holds no event of. */
  readonly events: readonly ServedEvent[];
  readonly cuts: readonly Cut[];
}

/** What the `history` document is built from. */
export interface HistoryInput {
  readonly task: string;
  /** The task's own events, in the order the register keeps them. */
  readonly events: Iterable<RegisterEvent>;
  readonly shapes: SecretShapes;
  readonly connectors: readonly Connector[];
  readonly names: SourceNames;
}

/** A cut's record: the event the text was in, as its task and its place in `events`, counted from 0. */
export function eventKeyOf(task: string, place: number): string {
  return `${task}#${place}`;
}

/**
 * The `history` document's body. A title or a description is marked by the source the task had once the event was
 * written, as the `tasks` document marks the folded ones: a tracker's import carries its author's words. An event
 * with no create before it has no known source and is marked outside, the side that escapes what it prints.
 */
export function historyBody(input: HistoryInput): HistoryBody {
  const served = new ServedText(input.shapes);
  const events: ServedEvent[] = [];
  let source: string | null = null;
  for (const event of input.events) {
    source = sourceAfter(event, source);
    events.push(servedEvent(event, { served, record: eventKeyOf(input.task, events.length), source, input }));
  }
  return { task: input.task, events, cuts: served.cuts };
}

/** The task's source once `event` is written. */
function sourceAfter(event: RegisterEvent, before: string | null): string | null {
  switch (event.type) {
    case 'create':
      return event.task.source;
    case 'update':
      return event.changes.source ?? before;
    case 'status':
    case 'moved':
      return before;
  }
}

/** What one event's texts are served through and read against. */
interface EventContext {
  readonly served: ServedText;
  /** The record a cut of this event names ({@link eventKeyOf}). */
  readonly record: string;
  /** The task's source once the event is written; null when no create came before it. */
  readonly source: string | null;
  readonly input: Pick<HistoryInput, 'connectors' | 'names'>;
}

function servedEvent(event: RegisterEvent, context: EventContext): ServedEvent {
  switch (event.type) {
    case 'create':
      return servedCreate(event, context);
    case 'status':
      return servedStatus(event, context);
    case 'update':
      return servedUpdate(event, context);
    case 'moved':
      return { kind: 'moved', at: event.at, by: event.by, to: event.to };
  }
}

function servedCreate(event: CreateEvent, context: EventContext): ServedCreate {
  const { served, record, input } = context;
  const { task } = event;
  const wrote = wroteOf(context);
  return {
    kind: 'create',
    at: event.at,
    by: event.by,
    task: {
      title: served.marked(record, 'task.title', task.title, wrote),
      description: served.markedOrNull(record, 'task.description', task.description, wrote),
      owner: task.owner,
      priority: task.priority,
      type: task.type,
      critical: task.critical,
      due: task.due,
      source: sourceOf(served, record, task.source, input.names),
      ref: refOf(served, record, task.ref, input.connectors),
      goals: [...task.goals],
      week: task.week,
      size: task.size,
      pin: task.pin,
      workClass: task.workClass,
      after: [...task.after],
    },
  };
}

function servedStatus(event: StatusEvent, { served, record }: EventContext): ServedStatusChange {
  return {
    kind: 'status',
    at: event.at,
    by: event.by,
    status: event.status,
    note: served.plainOrNull(record, 'note', event.note),
    evidence: served.plainOrNull(record, 'evidence', event.evidence),
    skill: served.plainOrNull(record, 'skill', event.skill),
    proof: served.plainOrNull(record, 'proof', event.proof ?? null),
    watch: served.plainOrNull(record, 'watch', event.watch ?? null),
    met: served.plainOrNull(record, 'met', event.met ?? null),
    oneCommit: event.oneCommit === true,
    waits: event.waits === undefined ? null : event.waits.map(servedWait),
    followups: event.followups === undefined ? null : [...event.followups],
  };
}

function servedUpdate(event: UpdateEvent, context: EventContext): ServedUpdate {
  return {
    kind: 'update',
    at: event.at,
    by: event.by,
    changes: servedChanges(event.changes, context),
    note: context.served.plainOrNull(context.record, 'note', event.note),
    verdict: event.verdict ?? null,
    waits: event.waits === undefined ? null : event.waits.map(servedWait),
    decided: event.decided === true,
  };
}

/** Each field an update gave, written out one by one, so a field the register adds is not served by accident. */
function servedChanges(changes: Partial<TaskFields>, context: EventContext): Partial<ServedFields> {
  const { served, record, input } = context;
  const wrote = wroteOf(context);
  return {
    ...(changes.title === undefined ? {} : { title: served.marked(record, 'changes.title', changes.title, wrote) }),
    ...(changes.description === undefined ? {} : { description: served.markedOrNull(record, 'changes.description', changes.description, wrote) }),
    ...(changes.owner === undefined ? {} : { owner: changes.owner }),
    ...(changes.priority === undefined ? {} : { priority: changes.priority }),
    ...(changes.type === undefined ? {} : { type: changes.type }),
    ...(changes.critical === undefined ? {} : { critical: changes.critical }),
    ...(changes.due === undefined ? {} : { due: changes.due }),
    ...(changes.source === undefined ? {} : { source: sourceOf(served, record, changes.source, input.names) }),
    ...(changes.ref === undefined ? {} : { ref: refOf(served, record, changes.ref, input.connectors) }),
    ...(changes.goals === undefined ? {} : { goals: [...changes.goals] }),
    ...(changes.week === undefined ? {} : { week: changes.week }),
    ...(changes.size === undefined ? {} : { size: changes.size }),
    ...(changes.pin === undefined ? {} : { pin: changes.pin }),
    ...(changes.workClass === undefined ? {} : { workClass: changes.workClass }),
    ...(changes.after === undefined ? {} : { after: [...changes.after] }),
  };
}

/** Who wrote the event's title and description: outside the team for a tracker's import, and where no source is known. */
function wroteOf({ source, input }: EventContext): TextSource {
  const known = source !== null && !input.names.connectors.some((connector) => connector.id === source);
  return known ? 'team' : 'outside';
}
