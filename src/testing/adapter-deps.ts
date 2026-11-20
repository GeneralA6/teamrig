import { SecretScanner } from '../core/secrets.ts';
import type { ConnectorDeps, HostDeps, ProgramRunner } from '../plugin-api/index.ts';
import { FakeCredentials } from './fake-credentials.ts';
import { FakeHttp } from './fake-http.ts';

const noProgram: ProgramRunner = () => Promise.reject(new Error('no program runs here'));

/** What a loader hands a host adapter, on Linux with an empty environment and no program to run; `over` replaces fields. */
export function hostDeps(over: Partial<HostDeps> = {}): HostDeps {
  return { env: {}, platform: 'linux', run: noProgram, ...over };
}

/** What a loader hands a connector adapter, with no credential stored, no program to run and no API that answers; `over` replaces fields. */
export function connectorDeps(over: Partial<ConnectorDeps> = {}): ConnectorDeps {
  return { run: noProgram, http: new FakeHttp(), credentials: new FakeCredentials(), env: {}, scanner: new SecretScanner(), stamp: true, ...over };
}
