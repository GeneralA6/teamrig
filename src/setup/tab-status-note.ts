import { ENV } from '../core/home.ts';

/**
 * What `team create` says about tab status, a colored circle before each tab's title for what its session is
 * doing (hook-tab-status.ts). The circle shows only when the team's config turns it on, which a new team's
 * does, and Claude Code leaves the tab title to hooks. That switch sits in Claude Code's own settings and
 * also takes the title from tabs of projects outside teamrig, so teamrig names it and never writes it.
 */
export interface TabStatusFacts {
  readonly team: string;
  /** Whether the team's config, new or kept, has `tabStatus.enabled`. */
  readonly configOn: boolean;
  readonly configPath: string;
  /** Whether Claude Code leaves the tab title to hooks (`CLAUDE_CODE_DISABLE_TERMINAL_TITLE`). */
  readonly titleLeft: boolean;
  /** The Claude Code settings file whose `env` takes that switch. */
  readonly settingsPath: string;
}

/** One line: tab status on, or what the user does to see it. */
export function tabStatusLine(facts: TabStatusFacts): string {
  const missing = [
    ...(facts.configOn ? [] : [`set "tabStatus": { "enabled": true } in ${facts.configPath}`]),
    ...(facts.titleLeft
      ? []
      : [
          `add "${ENV.claudeTitleOff}": "1" to "env" in ${facts.settingsPath} and restart Claude Code, so it stops writing its own title over the circle (tabs of projects outside teamrig then keep the terminal's title)`,
        ]),
  ];
  if (missing.length === 0) {
    return `TAB STATUS on: each tab of team ${facts.team} shows a colored circle before its title for what its session is doing: green ready, yellow working, orange waiting on you`;
  }
  return `NOTE each tab of team ${facts.team} shows a colored circle before its title for what its session is doing once you ${missing.join(', and ')}`;
}
