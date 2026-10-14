import type { Git } from './git.ts';

/** Test double for `Git`: answers from a table keyed by the joined argument list. */
export class FakeGit implements Git {
  readonly calls: string[][] = [];
  private readonly responses: ReadonlyMap<string, string | Buffer>;

  constructor(responses: Readonly<Record<string, string | Buffer>>) {
    this.responses = new Map(Object.entries(responses));
  }

  async text(args: readonly string[]): Promise<string> {
    const response = this.respond(args);
    return typeof response === 'string' ? response : response.toString('utf8');
  }

  async bytes(args: readonly string[]): Promise<Buffer> {
    const response = this.respond(args);
    return typeof response === 'string' ? Buffer.from(response, 'utf8') : response;
  }

  private respond(args: readonly string[]): string | Buffer {
    this.calls.push([...args]);
    const key = args.join(' ');
    const response = this.responses.get(key);
    if (response === undefined) {
      throw new Error(`unexpected git call: ${key}`);
    }
    return response;
  }
}
