import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connectorDeps } from '../testing/adapter-deps.ts';
import { FakeIssueHost } from '../testing/fake-issue-host.ts';
import { SUPPORTED, UNSUPPORTED, connectorDeclarationData, manifestOf } from '../testing/manifests.ts';
import { trackerOnly } from '../testing/split-hosts.ts';
import { stringField, type JsonRecord } from '../core/guards.ts';
import type { Tracker } from '../issues/host.ts';
import { connectorAdapterProblems, connectorDeclarationProblems, defineConnector, isConnectorAdapter, isConnectorDeclaration, type ConnectorAdapter, type ConnectorDeps } from './connector.ts';

const NOT_DEFINED = 'its entry is not made by defineConnector: it needs a declaration and a configure function';
const CONFIG_KEYS = 'its configKeys must name each config key in camelCase beside one line on what it holds';
const KINDS = 'its kinds must list tracker, codehost or both, each once';
const REF_PREFIX = 'its refPrefix must be a lower-case word ending in a colon';

describe('a connector declaration', () => {
  it('adds the kinds of connector it is and the prefix of its refs', () => {
    assert.deepEqual(connectorDeclarationProblems(connectorDeclarationData()), []);
    assert.equal(isConnectorDeclaration(connectorDeclarationData()), true);
  });

  it('lists tracker, codehost or both, each once', () => {
    for (const kinds of [[], ['tracker', 'tracker'], ['tracker', 'wiki'], 'tracker', undefined]) {
      assert.deepEqual(connectorDeclarationProblems(connectorDeclarationData({ kinds })), [KINDS], JSON.stringify(kinds));
    }
  });

  it('starts its refs with a lower-case word and a colon', () => {
    for (const refPrefix of ['gh:', 'local:', 'jira-cloud:']) assert.deepEqual(connectorDeclarationProblems(connectorDeclarationData({ refPrefix })), [], refPrefix);
    for (const refPrefix of ['gh', 'GH:', 'gh: ', ':', 7]) assert.deepEqual(connectorDeclarationProblems(connectorDeclarationData({ refPrefix })), [REF_PREFIX], String(refPrefix));
  });

  it('claims no feature of a kind it does not list', () => {
    const trackerOnly = connectorDeclarationData({ kinds: ['tracker'] });
    assert.deepEqual(connectorDeclarationProblems(trackerOnly), [
      'codehost.pull-news is not unsupported, but its kinds do not list codehost',
      'codehost.ci-excerpt is not unsupported, but its kinds do not list codehost',
      'codehost.pr-conflicts is not unsupported, but its kinds do not list codehost',
      'codehost.review-posts is not unsupported, but its kinds do not list codehost',
      'codehost.linked-pulls is not unsupported, but its kinds do not list codehost',
    ]);
    const honest = manifestOf('connector', UNSUPPORTED, { 'tracker.comment': SUPPORTED });
    assert.deepEqual(connectorDeclarationProblems(connectorDeclarationData({ kinds: ['tracker'], manifest: honest })), []);
  });

  it('reports a broken manifest once, with no word on kinds it cannot read rows for', () => {
    assert.deepEqual(connectorDeclarationProblems(connectorDeclarationData({ kinds: ['tracker'], manifest: 'none' })), ['its manifest is not an object']);
    assert.deepEqual(connectorDeclarationProblems(7), ['its declaration is not an object']);
  });

  it('names each key of its config section in camelCase beside one line on what it holds', () => {
    for (const configKeys of [{}, { site: 'the host name of the Jira site' }, { issueType: 'the type a new issue gets', projects: 'the project keys' }]) {
      assert.deepEqual(connectorDeclarationProblems(connectorDeclarationData({ configKeys })), [], JSON.stringify(configKeys));
    }
    for (const configKeys of [undefined, 'site', ['site'], { Site: 'the site' }, { 'issue-type': 'the type' }, { site: '' }, { site: ' ' }, { site: 7 }, { site: 'the site\nand more' }]) {
      assert.deepEqual(connectorDeclarationProblems(connectorDeclarationData({ configKeys })), [CONFIG_KEYS], JSON.stringify(configKeys));
    }
  });
});

interface SiteConfig {
  readonly site: string;
}

/** A connector reading one key, `site`, whose spec keeps each section it parsed and each build it made. */
function siteConnector(): { readonly adapter: ConnectorAdapter; readonly parsed: JsonRecord[]; readonly built: (readonly [ConnectorDeps, SiteConfig])[]; readonly tracker: Tracker } {
  const data = connectorDeclarationData({ configKeys: { site: 'the host name of the site' } });
  assert.ok(isConnectorDeclaration(data));
  const tracker = trackerOnly(new FakeIssueHost());
  const parsed: JsonRecord[] = [];
  const built: (readonly [ConnectorDeps, SiteConfig])[] = [];
  const adapter = defineConnector({
    declaration: data,
    parseConfig: (section, report): SiteConfig => {
      parsed.push(section);
      const site = stringField(section, 'site');
      if (site === undefined) {
        report('site', 'must be a host name');
      }
      return { site: site ?? 'none' };
    },
    create: (deps, config) => {
      built.push([deps, config]);
      return { tracker };
    },
  });
  return { adapter, parsed, built, tracker };
}

/** What `adapter` reports of `section`, each as the key and its problem. */
function reportsOf(adapter: ConnectorAdapter, section: JsonRecord): readonly string[] {
  const problems: string[] = [];
  adapter.configure(section, (key, problem) => problems.push(`${key} ${problem}`));
  return problems;
}

describe('defineConnector', () => {
  it('keeps the declaration, reads the config section once, and hands what it read to each build with its deps', () => {
    const { adapter, parsed, built, tracker } = siteConnector();
    const section = { site: 'acme.example' };
    const problems: string[] = [];
    const build = adapter.configure(section, (key, problem) => problems.push(`${key} ${problem}`));
    assert.deepEqual(problems, []);
    assert.deepEqual(built, []);
    const [first, second] = [connectorDeps(), connectorDeps()];
    assert.deepEqual(build(first), { tracker });
    assert.deepEqual(build(second), { tracker });
    assert.deepEqual(parsed, [section]);
    assert.deepEqual(built, [
      [first, { site: 'acme.example' }],
      [second, { site: 'acme.example' }],
    ]);
    assert.equal(isConnectorAdapter(adapter), true);
  });

  it('reports each section key the declaration does not list, naming those it takes, before what the connector reports', () => {
    const { adapter } = siteConnector();
    assert.deepEqual(reportsOf(adapter, { sight: 'acme.example', constructor: 1 }), [
      'sight is no key of the Some Tool connector; it takes site',
      'constructor is no key of the Some Tool connector; it takes site',
      'site must be a host name',
    ]);
  });

  it('says a connector with no config key takes none, and still builds with the default the connector read', () => {
    const data = connectorDeclarationData();
    assert.ok(isConnectorDeclaration(data));
    const adapter = defineConnector({ declaration: data, parseConfig: () => undefined, create: () => ({}) });
    assert.deepEqual(reportsOf(adapter, { site: 'acme.example' }), ['site is no key of the Some Tool connector; it takes none']);
    assert.deepEqual(adapter.configure({ site: 'acme.example' }, () => undefined)(connectorDeps()), {});
  });
});

describe('a connector adapter entry', () => {
  it('is refused when it is no declaration beside a configure function', () => {
    assert.deepEqual(connectorAdapterProblems({ declaration: connectorDeclarationData() }), [NOT_DEFINED]);
    assert.deepEqual(connectorAdapterProblems({ declaration: connectorDeclarationData(), create: () => ({}) }), [NOT_DEFINED]);
    assert.equal(isConnectorAdapter(null), false);
  });

  it('is refused for what is wrong with its declaration', () => {
    assert.deepEqual(connectorAdapterProblems({ declaration: connectorDeclarationData({ refPrefix: 'gh' }), configure: () => () => ({}) }), [REF_PREFIX]);
  });
});
