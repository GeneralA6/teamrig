import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { toJsonlLine } from '../core/jsonl.ts';
import type { LogFile } from '../core/log-file.ts';
import { SESSION_NAME } from '../register/model.ts';
import type { Inboxes, MarkLog } from './inbox.ts';
import { readMarks, type InboxMark, type MarkLogRead } from './marks.ts';
import { inboxLines } from './unread.ts';

const SUFFIX = '.md';

/** Inboxes as `<dir>/<area>.md`. Area names must be session ids, so none can escape the folder. */
export class InboxDir implements Inboxes {
  private readonly files: Files;
  private readonly dir: string;

  constructor(files: Files, dir: string) {
    this.files = files;
    this.dir = dir;
  }

  async areas(): Promise<string[]> {
    return (await this.files.list(this.dir))
      .filter((name) => name.endsWith(SUFFIX))
      .map((name) => name.slice(0, -SUFFIX.length))
      .filter((area) => SESSION_NAME.test(area))
      .sort();
  }

  async lines(area: string): Promise<string[] | undefined> {
    if (!SESSION_NAME.test(area)) {
      return undefined;
    }
    const text = await this.files.read(this.pathOf(area));
    return text === undefined ? undefined : inboxLines(text);
  }

  async append(area: string, line: string): Promise<void> {
    if (!SESSION_NAME.test(area)) {
      throw new Error(`${area} is not a session id`);
    }
    const path = this.pathOf(area);
    const current = await this.files.read(path);
    const separator = current === undefined || current === '' || current.endsWith('\n') ? '' : '\n';
    await this.files.append(path, `${separator}${line}\n`);
  }

  pathOf(area: string): string {
    return join(this.dir, `${area}${SUFFIX}`).replaceAll('\\', '/');
  }
}

/** Marks as one JSONL line each, in the log they are given: `inbox-marks.jsonl` or `inbox-shown.jsonl`. */
export class JsonlMarkLog implements MarkLog {
  private readonly log: LogFile;

  constructor(log: LogFile) {
    this.log = log;
  }

  async read(): Promise<MarkLogRead> {
    return readMarks((await this.log.read()) ?? '');
  }

  async append(mark: InboxMark): Promise<void> {
    await this.log.append(toJsonlLine({ ...mark }));
  }
}
