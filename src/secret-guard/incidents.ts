import type { Files } from '../core/files.ts';
import { stringField, type JsonRecord } from '../core/guards.ts';
import { assertWritable, parseJsonl, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import type { TimeZone } from '../core/zone.ts';

/**
 * The team's secret incidents, an append-only log (`<state>/secret-incidents.jsonl`): each kind of secret a tool's
 * result held, which the secret redactor kept from the model (T1369 R8), with the session, the tool and the task that
 * has it rotated; never the value. It is audit data: nothing trims it. A newer format is skipped on read and refuses a
 * write.
 */
export const SECRET_INCIDENTS_FORMAT = 1;

export interface SecretIncident {
  /** ISO instant. */
  readonly at: string;
  /** The session whose tool result held it; absent when the tab's session was not known. */
  readonly session?: string;
  /** The tool whose result held it: `Bash`, `Read`. */
  readonly tool: string;
  /** What it was, its shape's description: `GitHub token`. */
  readonly kind: string;
  /** The task that has it rotated, filed now or earlier that day: `T12` in the team's register, `web/T12` in another's. */
  readonly task?: string;
}

export interface SecretIncidentRead {
  readonly incidents: readonly SecretIncident[];
  /** Damaged lines and lines from a newer teamrig, skipped. */
  readonly skipped: number;
}

/** One incident as written; undefined for a line that is not one. */
export function parseSecretIncident(record: JsonRecord): SecretIncident | undefined {
  const at = stringField(record, 'at');
  const tool = stringField(record, 'tool');
  const kind = stringField(record, 'kind');
  if (at === undefined || !Number.isFinite(Date.parse(at)) || tool === undefined || kind === undefined) {
    return undefined;
  }
  const session = stringField(record, 'session');
  const task = stringField(record, 'task');
  return { at, ...(session === undefined ? {} : { session }), tool, kind, ...(task === undefined ? {} : { task }) };
}

/**
 * The task a session's incident of this kind was given on the zone's day of `now`, the newest one; undefined when
 * none was, so a filing that failed is tried again at the next incident.
 */
export function filedToday(incidents: readonly SecretIncident[], kind: string, session: string, now: Date, zone: TimeZone): string | undefined {
  const day = zone.day(now);
  return incidents.findLast((incident) => incident.kind === kind && incident.session === session && incident.task !== undefined && zone.day(new Date(incident.at)) === day)?.task;
}

/** The team's append-only log of secret incidents, oldest first. */
export class SecretIncidentLog {
  private readonly files: Files;
  readonly path: string;

  constructor(files: Files, path: string) {
    this.files = files;
    this.path = path;
  }

  async read(): Promise<SecretIncidentRead> {
    const parse = parseJsonl((await this.files.read(this.path)) ?? '');
    const incidents: SecretIncident[] = [];
    for (const { record, version } of parse.records) {
      const parsed = version === SECRET_INCIDENTS_FORMAT ? parseSecretIncident(record) : undefined;
      if (parsed !== undefined) {
        incidents.push(parsed);
      }
    }
    return { incidents, skipped: parse.unreadable + parse.records.length - incidents.length };
  }

  /** One whole line in one append; refused beside records from a newer teamrig. */
  async append(incident: SecretIncident): Promise<void> {
    const text = (await this.files.read(this.path)) ?? '';
    assertWritable(this.path, parseJsonl(text), SECRET_INCIDENTS_FORMAT);
    const separator = text === '' || text.endsWith('\n') ? '' : '\n';
    await this.files.append(this.path, `${separator}${toJsonlLine({ [VERSION_FIELD]: SECRET_INCIDENTS_FORMAT, ...incident })}`);
  }
}
