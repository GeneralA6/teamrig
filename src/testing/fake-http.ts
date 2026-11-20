import type { HttpClient, HttpMethod, HttpRequest, HttpResult } from '../core/http.ts';

/**
 * An outside tool's API held in memory: each request is recorded, and answered by what a test queued for its method
 * and URL. A request no test routed fails, so a spec never passes on a call it did not expect.
 */
export class FakeHttp implements HttpClient {
  /** The requests sent, in order. */
  readonly requests: HttpRequest[] = [];
  private readonly routes = new Map<string, HttpResult[]>();

  private queue(method: HttpMethod, url: string, result: HttpResult): this {
    const key = `${method} ${url}`;
    this.routes.set(key, [...(this.routes.get(key) ?? []), result]);
    return this;
  }

  /** The next `method` request to `url` gets this answer; the last one queued repeats for every request after it. */
  answers(method: HttpMethod, url: string, status: number, body: string = '', headers: Readonly<Record<string, string>> = {}): this {
    return this.queue(method, url, { kind: 'answered', status, headers, body });
  }

  /** The next `method` request to `url` fails with `reason`, as an unreachable server does. */
  failsOn(method: HttpMethod, url: string, reason: string): this {
    return this.queue(method, url, { kind: 'failed', reason });
  }

  async send(request: HttpRequest): Promise<HttpResult> {
    this.requests.push(request);
    const key = `${request.method} ${request.url}`;
    const queued = this.routes.get(key) ?? [];
    const [next, ...rest] = queued;
    if (next === undefined) {
      return { kind: 'failed', reason: `no answer is queued for ${key}` };
    }
    if (rest.length > 0) {
      this.routes.set(key, rest);
    }
    return next;
  }
}
