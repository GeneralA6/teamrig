import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS_COLUMNS, commandsScreen, paneLines } from './commands-screen.ts';
import { lineLength, renderTerminal } from './terminal-svg.ts';

describe('paneLines', () => {
  it('prints each command after a prompt, then its output, with a blank line between commands', () => {
    const lines = paneLines([
      { session: 'lead', command: 'teamrig list', output: ['T1 open, p1'] },
      { session: 'lead', command: 'teamrig show T1', output: [] },
    ]);
    assert.deepEqual(
      lines.map((line) => line.map((span) => span.text).join('')),
      ['$ teamrig list', 'T1 open, p1', '', '$ teamrig show T1'],
    );
  });
});

describe('commandsScreen', () => {
  it('shows the lead pane above the web pane, under four tabs with lead active', async () => {
    const screen = await commandsScreen();
    assert.equal(screen.layout, 'stacked');
    assert.deepEqual(
      screen.panes.map((pane) => pane.title),
      ['lead: a Claude Code session; Claude runs these commands', 'web: another Claude Code session'],
    );
    assert.deepEqual(
      screen.tabs.filter((tab) => tab.active).map((tab) => tab.label),
      ['lead'],
    );
    assert.equal(screen.tabs.length, 4);
  });

  it('fits every line in its columns, so the picture cuts nothing', async () => {
    const screen = await commandsScreen();
    const longest = Math.max(...screen.panes.flatMap((pane) => pane.lines.map(lineLength)));
    assert.ok(longest <= COMMANDS_COLUMNS, `the longest line has ${longest} characters`);
    assert.doesNotMatch(renderTerminal(screen, COMMANDS_COLUMNS), /…/);
  });

  it('shows web reading the lead note and starting its task', async () => {
    const web = (await commandsScreen()).panes[1];
    const text = (web?.lines ?? []).map((line) => line.map((span) => span.text).join(''));
    assert.ok(text.includes('- 2026-10-12 09:03 lead: T2 is yours (p1): Checkout'), text.join('\n'));
    assert.ok(text.includes("- 2026-10-12 09:06 lead: T2 builds on T1's API"), text.join('\n'));
    assert.ok(text.some((line) => line.startsWith('SET T2 in-progress, p1, owner web,')), text.join('\n'));
  });
});
