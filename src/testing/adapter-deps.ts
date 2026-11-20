import { SecretScanner } from '../core/secrets.ts';
import type { ConnectorDeps, HostDeps, ProgramRunner } from '../plugin-api/index.ts';
import { FakeCredentials } from './fake-credentials.ts';
import { FakeHttp } from './fake-http.ts';

const noProgram: ProgramRunner = () => Promise.reject(new Error('no program runs here'));

/** What a loader hands a host adapter, on Linux with an empty environment and no program to run; `over` replaces fields. */
export function hostDeps(over: Partial<HostDeps> = {}): HostDeps {
  return { env: {}, platform: 'linux', run: noProgram, ...over };
}

/**
 * The scanner a loader hands a connector, also finding the team's `extra` patterns. An adapter's spec builds its
 * scanner here: the plugin API hands an adapter the scanner's type alone, never the class.
 */
export function secretScanner(extra: readonly string[] = []): SecretScanner {
  return new SecretScanner(extra);
}

/** What a loader hands a connector adapter, with no credential stored, no program to run and no API that answers; `over` replaces fields. */
export function connectorDeps(over: Partial<ConnectorDeps> = {}): ConnectorDeps {
  return { run: noProgram, http: new FakeHttp(), credentials: new FakeCredentials(), env: {}, scanner: secretScanner(), stamp: true, ...over };
}
