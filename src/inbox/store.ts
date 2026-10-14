import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { parseJsonl, toJsonlLine } from '../core/jsonl.ts';
import { SESSION_NAME } from '../register/model.ts';
import type { Inboxes, MarkLog, MarkLogRead } from './inbox.ts';
import { parseMark, type InboxMark } from './marks.ts';

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
    return text?.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line.trim() !== '');
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

export class JsonlMarkLog implements MarkLog {
  private readonly files: Files;
  private readonly path: string;

  constructor(files: Files, path: string) {
    this.files = files;
    this.path = path;
  }

  async read(): Promise<MarkLogRead> {
    const parse = parseJsonl((await this.files.read(this.path)) ?? '');
    const marks: InboxMark[] = [];
    let unreadable = parse.unreadable;
    let newer = 0;
    for (const line of parse.records) {
      const result = parseMark(line);
      if (result.kind === 'mark') {
        marks.push(result.mark);
      } else if (result.kind === 'newer') {
        newer += 1;
      } else {
        unreadable += 1;
      }
    }
    return { marks, unreadable, newer };
  }

  async append(mark: InboxMark): Promise<void> {
    await this.files.append(this.path, toJsonlLine({ ...mark }));
  }
}
