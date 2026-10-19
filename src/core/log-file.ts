import type { Files } from './files.ts';

/**
 * A log that only grows: what its readers read and its writers append to. The plain one is a file; an aged one
 * also moves its old records to the state archive (aged-log.ts).
 */
export interface LogFile {
  /** The log's text; undefined when it does not exist yet. */
  read(): Promise<string | undefined>;
  append(text: string): Promise<void>;
}

/** A log that is one file, appended to without a lock. */
export class PlainLogFile implements LogFile {
  private readonly files: Files;
  private readonly path: string;

  constructor(files: Files, path: string) {
    this.files = files;
    this.path = path;
  }

  read(): Promise<string | undefined> {
    return this.files.read(this.path);
  }

  append(text: string): Promise<void> {
    return this.files.append(this.path, text);
  }
}
