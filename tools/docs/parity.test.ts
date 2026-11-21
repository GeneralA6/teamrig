import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readDeclarations, type Declarations, type Load } from '../../src/composition/loader.ts';
import {
  featuresOf,
  isConnectorDeclaration,
  isHostDeclaration,
  isTerminalDeclaration,
  type ConnectorDeclaration,
  type FeatureSide,
  type HostDeclaration,
  type ProofRef,
  type TerminalDeclaration,
} from '../../src/plugin-api/index.ts';
import { connectorDeclarationData, hostDeclarationData, manifestOf, SUPPORTED, terminalDeclarationData, UNSUPPORTED } from '../../src/testing/manifests.ts';
import { renderParity } from './parity.ts';

const proofOn = (os: ProofRef['os']): ProofRef => ({ os, toolVersion: '2.1.0', date: '2026-11-19', evidence: 'the proof record' });

function host(over: Readonly<Record<string, unknown>> = {}): Load<HostDeclaration> {
  const value = hostDeclarationData(over);
  assert.ok(isHostDeclaration(value));
  return { kind: 'loaded', id: value.id, value };
}

function connector(over: Readonly<Record<string, unknown>> = {}): Load<ConnectorDeclaration> {
  const value = connectorDeclarationData(over);
  assert.ok(isConnectorDeclaration(value));
  return { kind: 'loaded', id: value.id, value };
}

function terminal(over: Readonly<Record<string, unknown>> = {}): Load<TerminalDeclaration> {
  const value = terminalDeclarationData(over);
  assert.ok(isTerminalDeclaration(value));
  return { kind: 'loaded', id: value.id, value };
}

const page = (over: Partial<Declarations> = {}): string => renderParity({ hosts: [host()], connectors: [connector()], terminals: [terminal()], ...over });
/** The table row of one feature. */
const rowOf = (text: string, id: string): string | undefined => text.split('\n').find((line) => line.startsWith(`| \`${id}\` |`));
const headings = (text: string, level: string): string[] => text.split('\n').filter((line) => line.startsWith(`${level} `)).map((line) => line.slice(level.length + 1));

describe('renderParity', () => {
  it('says of a row that runs where it is proved, and of the others what is missing or why', () => {
    const manifest = manifestOf('host', SUPPORTED, {
      'rules.memory': { kind: 'supported', proofs: [proofOn('linux'), proofOn('windows'), proofOn('linux')] },
      'context.size': { kind: 'supported', proofs: [proofOn('macos'), proofOn('windows'), proofOn('linux')] },
      'sessions.wake': { kind: 'partial', missing: 'a wake while a turn runs', notice: 'an idle session only', proofs: [] },
      'sessions.carry': { kind: 'partial', missing: 'crons', notice: 'no crons', proofs: [proofOn('macos')] },
      'tabs.title-status': UNSUPPORTED,
    });
    const text = page({ hosts: [host({ manifest })] });
    assert.equal(rowOf(text, 'rules.session-start'), '| `rules.session-start` | team rules, identity and live tasks at a session start | supported, unproved |');
    assert.equal(rowOf(text, 'rules.memory'), '| `rules.memory` | memory files kept between sessions | supported, proved on windows, linux; unproved on macos |');
    assert.equal(rowOf(text, 'context.size'), '| `context.size` | the context size and its refresh thresholds | supported, proved on windows, linux, macos |');
    assert.equal(rowOf(text, 'sessions.wake'), '| `sessions.wake` | waking an idle session | partial (missing: a wake while a turn runs), unproved |');
    assert.match(rowOf(text, 'sessions.carry') ?? '', / \| partial \(missing: crons\), proved on macos; unproved on windows, linux \|$/);
    assert.equal(rowOf(text, 'tabs.title-status'), '| `tabs.title-status` | tab titles and status circles | unsupported: the tool has no such thing |');
  });

  it('gives each adapter of a side a column, in the order given, under its name', () => {
    const text = page({ connectors: [connector(), connector({ id: 'other-tool', name: 'Other Tool', apiVersion: '0.1.1', manifest: manifestOf('connector', UNSUPPORTED) })] });
    assert.ok(text.includes('\n| Feature | What it does | Some Tool | Other Tool |\n| --- | --- | --- | --- |\n'));
    assert.ok(text.includes('\n- Some Tool (`some-tool`), built on plugin API 0.1.0\n- Other Tool (`other-tool`), built on plugin API 0.1.1\n'));
    assert.match(rowOf(text, 'tracker.watch') ?? '', / \| supported, unproved \| unsupported: the tool has no such thing \|$/);
    assert.ok(text.includes('\n| Feature | What it does | Some CLI |\n| --- | --- | --- |\n'));
    assert.ok(text.includes('\n| Feature | What it does | Some Terminal |\n| --- | --- | --- |\n'));
    assert.ok(text.includes('\n- Some Terminal (`some-terminal`), built on plugin API 0.1.0\n'));
  });

  it('draws a row for every feature of the registry, under its group, hosts, then connectors, then terminals', () => {
    const text = page();
    const groups = (side: FeatureSide): string[] => [...new Set(featuresOf(side).map((row) => row.group))];
    assert.deepEqual(headings(text, '#'), ['Feature parity']);
    assert.deepEqual(headings(text, '##'), ['Hosts', 'Connectors', 'Terminals']);
    assert.deepEqual(headings(text, '###'), [...groups('host'), ...groups('connector'), ...groups('terminal')]);
    for (const row of [...featuresOf('host'), ...featuresOf('connector'), ...featuresOf('terminal')]) assert.ok(rowOf(text, row.id) !== undefined, row.id);
    const underRules = text.slice(text.indexOf('\n### rules\n'), text.indexOf('\n### inbox\n'));
    assert.deepEqual(underRules.split('\n').filter((line) => line.startsWith('| `')).map((line) => line.split('`')[1]), featuresOf('host').filter((row) => row.group === 'rules').map((row) => row.id));
  });

  it('keeps a pipe or a line break of a notice inside its cell, and ends in one newline', () => {
    const text = page({ hosts: [host({ manifest: manifestOf('host', SUPPORTED, { 'rules.memory': { kind: 'unsupported', notice: 'a | b\nc' } }) })] });
    assert.match(rowOf(text, 'rules.memory') ?? '', / \| unsupported: a \\\| b c \|$/);
    assert.match(text, /[^\n]\n$/);
  });

  it('refuses to draw a page when a declaration was refused, naming each with its notices', () => {
    const refused = (id: string, ...notices: string[]): Load<never> => ({ kind: 'refused', id, notices });
    assert.throws(
      () =>
        page({
          hosts: [host(), refused('bad-cli', 'it needs a name')],
          connectors: [refused('bad-tool', 'its declaration.ts did not load: gone', 'second')],
          terminals: [terminal(), refused('bad-terminal', 'it needs an id')],
        }),
      {
        message:
          'a refused declaration cannot be drawn: the host adapter bad-cli: it needs a name; the connector adapter bad-tool: its declaration.ts did not load: gone, second; the terminal adapter bad-terminal: it needs an id',
      },
    );
  });

  it('draws the adapters teamrig ships: Claude Code, then GitHub, Jira and the local connector, then the six terminals side by side', async () => {
    const text = renderParity(await readDeclarations());
    assert.ok(text.includes('\n| Feature | What it does | Claude Code |\n'));
    assert.ok(text.includes('\n| Feature | What it does | GitHub | Jira | Local |\n'));
    assert.ok(text.includes('\n| Feature | What it does | tmux | Windows Terminal | macOS Terminal | GNOME Terminal | Konsole | x-terminal-emulator |\n'));
    assert.match(rowOf(text, 'pane.window') ?? '', /^\| `pane\.window` \| [^|]+ \| unsupported: [^|]+ \| supported, unproved \| unsupported: /);
    assert.match(rowOf(text, 'tracker.hidden-mark') ?? '', / \| unsupported: GitHub shows every mark .* \| unsupported: the Jira connector keeps no hidden mark .* \| unsupported: the local connector .* \|$/);
  });
});
