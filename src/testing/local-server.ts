import assert from 'node:assert/strict';
import type { IncomingMessage, Server } from 'node:http';

/** The whole body of a request a local test server received, as text. */
export function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => done(body));
  });
}

/** Starts `server` on a free port of this machine alone; its base URL. */
export async function listening(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', 'a TCP server has a port');
  return `http://127.0.0.1:${address.port}`;
}

/** Ends `server`, dropping the connections a request it never answered still holds. */
export async function stopped(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}
