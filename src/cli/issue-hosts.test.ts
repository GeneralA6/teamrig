import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { loadConnector } from '../composition/loader.ts';
import { SecretScanner } from '../core/secrets.ts';
import { GITHUB_REPOS_HOST } from '../issues/host.ts';
import type { ConnectorDeps, ConnectorPorts, ProgramRunner } from '../plugin-api/index.ts';
import { FakeCredentials, TEST_OWNERS } from '../testing/fake-credentials.ts';
import { FakeGh } from '../testing/fake-gh.ts';
import { FakeHttp } from '../testing/fake-http.ts';
import { FakeIssueHost } from '../testing/fake-issue-host.ts';
import { connectorDeclarationData } from '../testing/manifests.ts';
import { programOverGh } from '../testing/program-over-gh.ts';
import { SRC_DIR, sourcesUnder, underSrc } from '../testing/source-files.ts';
import { codeHostOnly, trackerOnly } from '../testing/split-hosts.ts';
import { hostsOf, reposOf, type ConnectorLoader, type HostRuntime } from './issue-hosts.ts';
import { RefusedError } from './runtime.ts';

const OWN_ENV = { HOME: '/own' };

/** A program runner no spec here lets run: the hosts built over it are fakes. */
const noProgram: ProgramRunner = () => Promise.reject(new Error('no program runs here'));

/** The part of a CLI run a host is built from, with `run` as its runner of a connector's tool, an HTTP client of its own and a key saved for each test owner. */
function runtimeWith(run: ProgramRunner = noProgram): HostRuntime {
  return { run, http: new FakeHttp(), credentials: new FakeCredentials().savesTokensFor(TEST_OWNERS), env: OWN_ENV };
}

/**
 * A loader that serves one adapter, whatever folder the loader asks for: its declaration is sound and names the id
 * asked for, it builds `ports`, and it keeps what it was handed to build them from. The real loader checks it, so the
 * adapter hostsOf gets is one the loader accepted.
 */
function serving(ports: ConnectorPorts): { readonly load: ConnectorLoader; readonly given: ConnectorDeps[] } {
  const given: ConnectorDeps[] = [];
  const create = (deps: ConnectorDeps): ConnectorPorts => {
    given.push(deps);
    return ports;
  };
  return { load: (id) => loadConnector(id, () => Promise.resolve({ default: { declaration: connectorDeclarationData({ id }), create } })), given };
}

/** What `serving` was handed on its one build. */
function onlyDeps(given: readonly ConnectorDeps[]): ConnectorDeps {
  const [deps, ...more] = given;
  assert.ok(deps !== undefined && more.length === 0, `the adapter built ${given.length} times`);
  return deps;
}

function bothPorts(): Required<ConnectorPorts> {
  const fake = new FakeIssueHost();
  return { tracker: trackerOnly(fake), codeHost: codeHostOnly(fake) };
}

describe('hostsOf', () => {
  it('gives the tracker and the code host its connector adapter builds', async () => {
    const ports = bothPorts();
    const { load } = serving(ports);
    const hosts = await hostsOf(GITHUB_REPOS_HOST, runtimeWith(), new SecretScanner(), true, load);
    assert.equal(hosts.tracker, ports.tracker);
    assert.equal(hosts.codeHost, ports.codeHost);
  });

  it("hands the adapter the run's HTTP client, saved secrets and environment, the scanner and the stamp as given", async () => {
    for (const stamp of [true, false]) {
      const { load, given } = serving(bothPorts());
      const runtime = runtimeWith();
      const scanner = new SecretScanner();
      await hostsOf(GITHUB_REPOS_HOST, runtime, scanner, stamp, load);
      const deps = onlyDeps(given);
      assert.equal(deps.http, runtime.http);
      assert.equal(deps.credentials, runtime.credentials);
      assert.equal(deps.env, runtime.env);
      assert.equal(deps.scanner, scanner);
      assert.equal(deps.stamp, stamp);
    }
  });

  it("hands the adapter the run's own program runner, so each run of its tool keeps the connector limits that runner holds", async () => {
    const { load, given } = serving(bothPorts());
    const runtime = runtimeWith();
    await hostsOf(GITHUB_REPOS_HOST, runtime, new SecretScanner(), true, load);
    assert.equal(onlyDeps(given).run, runtime.run);
  });

  it('fails, naming every reason, when the loader refuses the adapter', async () => {
    const load: ConnectorLoader = (id) => Promise.resolve({ kind: 'refused', id, notices: ['it needs a name', 'its kinds must list tracker, codehost or both, each once'] });
    await assert.rejects(hostsOf(GITHUB_REPOS_HOST, runtimeWith(), new SecretScanner(), true, load), {
      name: 'HostAdapterError',
      message: 'the github connector adapter gave no host: it needs a name; its kinds must list tracker, codehost or both, each once',
    });
  });

  it('fails as a failure and not a refusal, since no caller asked wrongly', async () => {
    const load: ConnectorLoader = (id) => Promise.resolve({ kind: 'refused', id, notices: ['it needs a name'] });
    await assert.rejects(hostsOf(GITHUB_REPOS_HOST, runtimeWith(), new SecretScanner(), true, load), (error) => error instanceof Error && !(error instanceof RefusedError));
  });

  it('fails, naming each port it lacks, when the adapter builds no tracker or no code host', async () => {
    const { tracker, codeHost } = bothPorts();
    const cases: readonly (readonly [ConnectorPorts, string])[] = [
      [{}, 'it builds no tracker; it builds no code host'],
      [{ tracker }, 'it builds no code host'],
      [{ codeHost }, 'it builds no tracker'],
    ];
    for (const [ports, reasons] of cases) {
      await assert.rejects(hostsOf(GITHUB_REPOS_HOST, runtimeWith(), new SecretScanner(), true, serving(ports).load), {
        name: 'HostAdapterError',
        message: `the github connector adapter gave no host: ${reasons}`,
      });
    }
  });

  it('loads the GitHub adapter teamrig ships when no loader is given', async () => {
    const hosts = await hostsOf(GITHUB_REPOS_HOST, runtimeWith(programOverGh(new FakeGh())), new SecretScanner(), true);
    assert.equal(hosts.tracker.name, 'GitHub');
    assert.equal(hosts.codeHost.name, 'GitHub');
    assert.equal((await hosts.tracker.reach('acme/web', 'read')).kind, 'reached');
  });
});

describe('reposOf', () => {
  it('reads every repository of the list, or the one asked for in any case', () => {
    assert.deepEqual(reposOf(['acme/web', 'globex/api'], undefined), ['acme/web', 'globex/api']);
    assert.deepEqual(reposOf(['acme/web', 'globex/api'], ' Acme/Web '), ['acme/web']);
  });

  it('refuses a repository the list does not name', () => {
    assert.throws(() => reposOf(['acme/web'], 'acme/other'), new RefusedError('--repo acme/other is not one of github.repos (acme/web)'));
  });
});

/**
 * The CLI names no host: a command asks hostsOf for the host of a kind it read from the team config, and the kind's
 * connector adapter builds it. So a second host is one more adapter and one more kind, and no command changes. Two
 * things would undo that, and the scan below finds both: code beyond the GitHub adapter building GitHub's host itself,
 * and a call that asks hostsOf for a host by a name written into it.
 */

/** The one file that builds GitHub's host, as a path under `src` with `/`. */
const GITHUB_ADAPTER = 'adapters/connectors/github/index.ts';
const GITHUB_HOST_CLASS = 'GitHubIssueHost';
const HOSTS_OF = 'hostsOf';

/** One place a source names a host, with its 1-based line. */
interface HostNaming {
  readonly line: number;
  readonly text: string;
}

/** What `node` names of a host: a build of GitHub's own, or a hostsOf call whose kind is a string written there. */
function hostNamed(node: ts.Node, file: ts.SourceFile): string | undefined {
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === GITHUB_HOST_CLASS) {
    return `new ${GITHUB_HOST_CLASS}`;
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === HOSTS_OF) {
    const [kind] = node.arguments;
    return kind !== undefined && ts.isStringLiteralLike(kind) ? `${HOSTS_OF}(${kind.getText(file)})` : undefined;
  }
  return undefined;
}

/** The places a source names a host; a comment is no token, so an example in one is not a naming. */
function hostNamings(fileName: string, source: string): HostNaming[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: HostNaming[] = [];
  const visit = (node: ts.Node): void => {
    const text = hostNamed(node, file);
    if (text !== undefined) {
      found.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, text });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe('hostNamings', () => {
  it("finds a build of GitHub's host and a hostsOf call that writes its kind as a string", () => {
    const source = [
      'const host = new GitHubIssueHost(gh, tokens, scanner, stamp);',
      "const hosts = await hostsOf('github', runtime, scanner, stamp);",
      'const more = await hostsOf(`github`, runtime, scanner, stamp);',
      'const nested = wrap(() => new GitHubIssueHost(gh, tokens, scanner, stamp));',
    ].join('\n');
    assert.deepEqual(hostNamings('a.ts', source), [
      { line: 1, text: 'new GitHubIssueHost' },
      { line: 2, text: "hostsOf('github')" },
      { line: 3, text: 'hostsOf(`github`)' },
      { line: 4, text: 'new GitHubIssueHost' },
    ]);
  });

  it('leaves a hostsOf call that passes its kind on, the class as a type, another build and a comment', () => {
    const source = [
      'const hosts = await hostsOf(GITHUB_REPOS_HOST, runtime, scanner, stamp);',
      'const other = await hostsOf(kind, runtime, scanner, stamp);',
      "import type { GitHubIssueHost } from '../github/host.ts';",
      'function named(host: GitHubIssueHost): string { return host.name; }',
      'const fake = new FakeIssueHost();',
      "const text = 'new GitHubIssueHost(gh)';",
      "// hostsOf('github', runtime, scanner, stamp) builds new GitHubIssueHost(...)",
    ].join('\n');
    assert.deepEqual(hostNamings('a.ts', source), []);
  });
});

describe('teamrig code', () => {
  it("builds GitHub's host in its connector adapter alone, and asks for no host by a name written into the call (T4619)", () => {
    const files = sourcesUnder(SRC_DIR).filter((path) => underSrc(path) !== GITHUB_ADAPTER);
    assert.ok(files.length > 100, `the scan read only ${files.length} files`);
    const found = files.flatMap((path) => hostNamings(path, readFileSync(path, 'utf8')).map((naming) => `${underSrc(path)}:${naming.line} ${naming.text}`));
    assert.deepEqual(found, []);
  });

  it('builds it in that adapter, so the scan above exempts a file that is there', () => {
    const adapter = sourcesUnder(SRC_DIR).filter((path) => underSrc(path) === GITHUB_ADAPTER);
    assert.deepEqual(
      adapter.flatMap((path) => hostNamings(path, readFileSync(path, 'utf8')).map((naming) => naming.text)),
      [`new ${GITHUB_HOST_CLASS}`],
    );
  });
});
