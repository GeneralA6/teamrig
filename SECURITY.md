# Security policy

## Reporting a vulnerability

Please report a vulnerability privately, never in a public issue, pull request or discussion:

1. Open the repository's **Security** tab and choose **Report a vulnerability**
   ([new private report](https://github.com/GeneralA6/teamrig/security/advisories/new)).
2. Say what an attacker can do, the teamrig version (`teamrig --version`), the operating system, and the steps
   that show it. A proof of concept helps; keep it to what shows the flaw.

The report is seen only by the maintainer and you. We answer in the report, work on the fix there, and publish the
advisory with the fixed version once it is out, crediting you unless you ask not to be named.

## What counts

teamrig runs inside Claude Code with the rights of the user who runs it, so the flaws that matter most are those
that let something cross a line it should not:

- a guard or hook that can be talked past: a push, a command or a write the guard is there to refuse goes through;
- a team file, inbox line, register entry or GitHub issue that makes teamrig run a command or change a file it
  should not;
- a secret, token or private path written where it should not be: a log, a commit, a GitHub issue or the dist;
- a dependency or GitHub Action with a known advisory that teamrig's code reaches.

A finding that needs the attacker to already run commands as the same user is out of scope: that user can do
anything teamrig can.

## Supported versions

Only the newest released version gets fixes. Installs update when the version in
`plugins/teamrig/.claude-plugin/plugin.json` rises (see
[Updating the plugin](docs/how-it-works.md#updating-the-plugin)), so a fix reaches you through the usual update.
