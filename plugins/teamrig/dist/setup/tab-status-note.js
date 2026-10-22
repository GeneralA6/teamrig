import { ENV } from "../core/home.js";
/** One line: tab status on, or what the user does to see it. */
export function tabStatusLine(facts) {
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
