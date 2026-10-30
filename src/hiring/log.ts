import type { Files } from '../core/files.ts';
import type { JsonRecord } from '../core/guards.ts';
import { assertWritable, parseJsonl, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import { HIRE_FORMAT, readHiringLog, type HiringLogRead, type HiringRecord } from './record.ts';

function recordOf(record: HiringRecord): JsonRecord {
  const base = { [VERSION_FIELD]: HIRE_FORMAT, kind: record.kind, session: record.session, reason: record.reason, by: record.by, at: new Date(record.at).toISOString() };
  switch (record.kind) {
    case 'retire':
      return {
        ...base,
        ...(record.handover === undefined ? {} : { handover: record.handover }),
        ...(record.noHandover === undefined ? {} : { noHandover: record.noHandover }),
        ...(record.heir === undefined ? {} : { heir: record.heir }),
      };
    case 'keep':
      return { ...base, reviewBy: record.reviewBy };
    case 'hire':
      return {
        ...base,
        scope: record.scope,
        ...(record.approvedBy === undefined ? {} : { approvedBy: record.approvedBy }),
        ...(record.model === undefined ? {} : { model: record.model }),
        ...(record.effort === undefined ? {} : { effort: record.effort }),
        reviewBy: record.reviewBy,
        ...(record.burst === undefined ? {} : { burst: new Date(record.burst).toISOString() }),
      };
  }
}

/** The team's append-only log of hires, keeps and retires, `<state>/hires.jsonl`, oldest first. */
export class HiringLog {
  private readonly files: Files;
  readonly path: string;

  constructor(files: Files, path: string) {
    this.files = files;
    this.path = path;
  }

  async read(): Promise<HiringLogRead> {
    return readHiringLog((await this.files.read(this.path)) ?? '');
  }

  /** One whole line in one append; refused beside records from a newer teamrig. */
  async append(record: HiringRecord): Promise<void> {
    const text = (await this.files.read(this.path)) ?? '';
    assertWritable(this.path, parseJsonl(text), HIRE_FORMAT);
    const separator = text === '' || text.endsWith('\n') ? '' : '\n';
    await this.files.append(this.path, `${separator}${toJsonlLine(recordOf(record))}`);
  }
}
