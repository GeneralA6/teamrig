# Contributing

## Development

```sh
npm ci                # also points git at .githooks (scrub + DCO sign-off checks, the local gate before each push, no push to main)
npm run setup         # the same hook setup, for a clone installed with --ignore-scripts (npm run check fails until it runs)
npm run check         # that git runs the repo hooks, then CI's gates on your tree: typecheck, build, tests with the coverage gate, dist smoke, fresh install, pictures, config reference, parity page, layer boundaries, doc links, scrub
npm run docs:images   # redraws the pictures in docs/images
npm run docs:config   # redraws docs/configuration.md from the config schema
npm run docs:parity   # redraws docs/parity.md from what each adapter declares and the feature registry
npm run docs:check    # checks relative links, anchors and Mermaid diagram types in the top-level and docs/ Markdown
node tools/ci/local.ts # the local gate: every CI check on the committed tree, once per tree (--light: the pre-push hook's checks)
```

The pictures in the docs are drawn in code (`tools/docs/`), the commands screen by running the real CLI for a made-up
team, [the configuration reference](docs/configuration.md) from each key's `description` in
`plugins/teamrig/config.schema.json`, and [the parity page](docs/parity.md) from each adapter's `declaration.ts` under
`src/adapters` and the feature registry (a file per group under `src/features/host`, `src/features/connector` and
`src/features/terminal`), so none can drift from the code or from what the CLI prints: the checks fail until they are
redrawn. To change a key's text, edit its `description` and run `npm run docs:config`; to change what a tool supports,
edit its adapter's declaration and run `npm run docs:parity`. The layer boundaries of `src` (what the core and an
adapter may import, who may import an adapter or a fake of `src/testing`, where a tool is named) are counted by
`node tools/ci/boundaries-cli.ts`, in warn mode: it prints the counts and fails nothing yet. The host and tool words in
each skill (a step a skill tells, which an adapter says how to do) are counted by `node tools/ci/provider-words-cli.ts`
against `tools/ci/provider-words.json`: a count may fall, never rise, and `--write` records a fall. The sections below
give the test and sign-off rules.

## How we work
Every contributor, and every Claude Code session opened in this repo, works the same way. [CLAUDE.md](CLAUDE.md) holds
the rules that apply on every turn, and the project skills in `.claude/skills/` the steps of each repeated job:

| Skill | Use it for |
| --- | --- |
| [`dev-add-command`](.claude/skills/dev-add-command/SKILL.md) | a new CLI command, or a flag on one |
| [`dev-add-config-key`](.claude/skills/dev-add-config-key/SKILL.md) | a new key in the team config |
| [`dev-update-docs`](.claude/skills/dev-update-docs/SKILL.md) | the docs a change must update, and the checks that hold them to the code |
| [`dev-ship-change`](.claude/skills/dev-ship-change/SKILL.md) | from the last commit to the merge: checks, push, pull request |
| [`dev-ship-release`](.claude/skills/dev-ship-release/SKILL.md) | merging the release pull request: the lead's approval of its head, then `ship.ts merge --release` |
| [`dev-design-issue`](.claude/skills/dev-design-issue/SKILL.md) | joining a design issue: a reasoned comment, nothing taken until it is agreed, no sensitive data |
| [`dev-github-intake`](.claude/skills/dev-github-intake/SKILL.md) | a maintainer taking in issues and pull requests: labels, best fix first, landing with credit, design issues |

- **One branch per change**, cut from the newest `origin/main` (see [Branches and releases](#branches-and-releases)).
- **One logical change per commit**: a fix with its tests, a refactor apart from what it enables, a mechanical change
  alone, each committed once its step passes, so a reviewer reads one idea at a time and a bad step reverts alone. A
  commit past 400 changed non-test lines or 15 non-test files carries a `Large-commit: <reason>` line saying why it
  cannot be split; these are the limits teamrig itself applies to a team's pushes.
- **Docs in the same pull request** as the change they describe, so `main` never documents what it does not do.
- **Every program teamrig starts is hidden**: each `spawn`, `spawnSync`, `execFile` or `execFileSync` passes
  `windowsHide: true`. A queue run in the background has no console, so on Windows a program it starts otherwise opens
  a terminal tab of its own. A call whose window is the point says so on the line above it (`// Shown on purpose:
  <why>`); `src/core/hidden-children.test.ts` holds both.
- **Typed code with no casts**: no `any`, no `as unknown as`; narrow `unknown` with a type guard.
- **The why in plain words, where the reader finds it**: a comment says why the code is as it is, with a task or issue
  id only as a trace and never a path outside the repo; a pull request that settles a design question says in its
  `## Why` the options weighed and why this one won. There is no decisions folder: the reasons
  live in the code, its issues and its pull requests, and [how it works](docs/how-it-works.md) shows how the parts fit.
- When a step in a skill turns out wrong, fix the skill in the same pull request.
- **Generic first**: every change has a reach, decided before it is built and stated in its task and its pull request
  (see [Where a change lives](#where-a-change-lives)).

### What a change is held to

The author builds to these and the reviewer checks each one:

- **SOLID**: one reason to change per module; new behaviour added beside the old, not by editing what callers rely
  on; small interfaces; code that depends on a port, not on the outside tool behind it.
- **Reuse before writing**: search for the module, helper or fake that already does the job, and extend it. A second
  copy of a rule drifts from the first.
- **The architecture and the decisions already taken**: the change fits [how it works](docs/how-it-works.md), the
  design issues marked `Agreed:` and the design docs, or it says which one it changes and why.
- **Extensibility weighed early**: ask what a later, more mature architecture would need (another AI CLI, another
  issue tracker, another UI over the [public interface](docs/design/public-interface.md)). Do now what is cheap now and
  costly later, such as a port, a config key in place of a constant, or data in place of a branch in code. Build
  no hook for a need no one has named. A design lists these early steps.
- **Risks named**: every design, issue and pull request says what could go wrong (a break for a caller, a security
  or data risk, a cost, a migration) and how each is softened, or says `none foreseen` and why.
- **A critical, unbiased review**: the reviewer reads to find what is wrong, not to agree, and holds the change to
  this list whoever wrote it. A wrong direction is declined or pushed back on, with the reason and the better way,
  because a bad direction accepted costs far more than a round trip. Each finding says why.

## Where a change lives
teamrig is its own main user: its own sessions build it with it, so a fix they need is most often one every team
needs. Each change has one of three reaches, and generic is the default:

| Reach | Where it lives | Such as |
| --- | --- | --- |
| **all users** | the plugin: a command or flag (`src/`), a config key with a default, a hook, a plugin skill (`plugins/teamrig/skills/`), the core rules | a check flag, a guard, a step of the guide |
| **teamrig development** | this repository's own tooling: `.claude/skills/dev-*`, `tools/`, `.github/`, CONTRIBUTING.md, CLAUDE.md | the ship tool, the docs checks, a CI gate |
| **one team** | that team's own files: its team rules, its sessions' skills and memory, outside this repository | a team's repository names, its owner's decisions |

Decide it by asking, in order:

1. Would a team that never touches teamrig's code need this, maybe with values of its own? Then it is for **all
   users**: ship it in the plugin, and put any value that differs per team in a config key with a default, never
   hard-coded.
2. Is it about building, testing, documenting or releasing teamrig itself? Then it is **teamrig development**.
3. Only what neither answers is for **one team**. A one-team stopgap for a need that is really generic names the
   all-users task that replaces it (`stopgap T<id>`).

A task says its reach in its description, an approval request in its note, and a pull request in its `## Reach`
section. A reviewer who reads a one-team or teamrig-development reach on what is really generic asks for it to move.

## Sign-off (DCO)
Every commit must carry a `Signed-off-by:` line that matches the commit author, certifying the
[Developer Certificate of Origin 1.1](https://developercertificate.org/). Add it with:

```sh
git commit -s
```

The `commit-msg` hook (set by `npm ci` or `npm run setup`) and the local gate both reject a commit without it.

## Tests
Every change ships tests, so the next change cannot break it unnoticed:
- A new behaviour gets a test that would fail without it. A bug fix gets a regression test that
  fails on the old code: run it before the fix and watch it fail.
- Tests live beside the code as `<name>.test.ts` under `src/` or `tools/` (`node:test`), and run
  on Linux, Windows and macOS. Build paths with `path.join`, never with literal separators.
- Use the fakes in `src/testing/` and `tools/lib/fake-git.ts` instead of real time, disks or git
  where a unit test fits; spawn the real entry point (`process.execPath`) to test a CLI.
- No skipped or todo tests: a test that does not run catches nothing.
- A change to a threshold, limit or trigger (a count, a timeout, a restart or retry limit, a wake condition) gets a
  spec of the trigger firing in the real flow, with whatever resets its count on the way (a compaction, a `/clear`,
  a restart): a unit test of the comparison alone passes even when the real flow resets the count before it fires.
- A recorded Claude Code session (`src/testing/recorded/claude-code/`, recorded with `node tools/record/cli.ts`) holds
  the hook inputs and transcripts a real session sent, and its `expected/` folder pins what teamrig prints for each;
  `src/testing/recorded-pins.test.ts` fails when the code and the pins differ. A refactor leaves the pins as they are.
  A change meant to alter what a hook prints, or a core rule's wording (the session-start pins hold the rules text),
  runs `node tools/record/pins-cli.ts` from the repository's root and commits the diff with the change.
- What every adapter of a port must do is a contract of the conformance kit (`src/conformance/`), not a spec of one
  adapter: `defineContract({ port, side, cases, liars })` in the port's own file, listed in `CONTRACTS` with one
  `entryOf(...)` line. A case is a value that fails by throwing and speaks only through its `{ port, world }`, and
  names the feature rows it proves; the kit imports the plugin API, `node:assert` and its own folder alone, so it
  ships as it is to whoever builds an adapter outside. Every contract carries a liar (a subject that does nothing,
  or says yes to everything), and the kit's spec fails a contract whose liar passes every case of a feature. An
  adapter's contract spec is one call, `describeContracts({ side, declaration, bound: [bind(...)] })` of
  `src/testing/contracts.ts`: its manifest picks the cases, and the spec fails when it binds less than it claims.

`npm run check` runs every gate CI runs on the tree; the local gate also checks each pushed commit's sign-off and scrubs it,
which the git hooks `npm ci` sets do before each commit. Its coverage gate (`npm run coverage`) fails when:
- any test fails, or is skipped or todo;
- a source file under `src/` or `tools/` is loaded by no test, new and uncommitted files included;
- a file, or the total, falls below the floors in `tools/ci/coverage.json`;
- a test file is named or placed so `npm test` would never run it;
- the run prints nothing for `suiteIdleSeconds` in `tools/ci/coverage.json` (300 when unset): it is stopped with every
  process it started, so a test that never ends cannot hold the host. On a busy host (under 25% of its CPU idle when
  the limit passes) the run gets the limit again, up to three limits in all, as other steps' test runs can slow it
  that long.

Never lower a floor to pass a change. A file that truly cannot reach one (for example an error
path that needs a real disk failure) gets an entry under `exceptions` in `tools/ci/coverage.json`
with a reason the reviewer accepts; the gate reports the entry once the file no longer needs it.

## Stored files
A file teamrig keeps carries a format number (such as `USAGE_FORMAT` or `EVENT_VERSION`). A teamrig that
rewrites a file of its own format keeps only the fields it knows, and may read one holding a value it cannot
read as damaged. So a field added to a stored file, at any depth, or a value an older teamrig cannot read, is a
new format: raise the number in the same change and keep reading the older formats, so an older teamrig still
running in some tab refuses the file (`NewerDataError`) instead of dropping the field. A store that overwrites
a file refuses a newer format before it writes (`writableObject` for a one-object file, `assertWritable` for a
log, both in `src/core/jsonl.ts`); a store without that check needs one first. A test pins the fields of the
current format with `fieldPaths` (`src/testing/field-paths.ts`), as `src/budget/store.test.ts` does for the
usage files.

A field renamed in a stored file goes in two releases, since a tab keeps the teamrig it loaded until it reloads and
old and new code share the file meanwhile. The first release only reads: a `<STORE>_NEXT_FORMAT` constant beside
the written one names the format a later teamrig writes, the parser takes both formats and either field name, and
a store that refuses to write beside a newer format lets the next one pass. The writer moves in a later release,
once every tab reads it. Two tests hold each store to this: the exact line written today, and a line as the later
release will write it. `src/core/host-session.ts` and `src/sessions/log.ts` show the pattern.

The register's event log (`EVENT_VERSION`) is an exception: a field an older reader can ignore takes no new number.
Compaction copies each kept line as written, so no rewrite drops the field, and the header of
`src/register/events.ts` lists each field added this way. A line an older teamrig must not act on still raises the
number, as the `moved` record did.

The task pane (teamrig-pane) reads through a copy of the modules `src/read/index.ts` reaches, kept in its
`hooks/core`. A raise of a format among them needs that copy re-synced (the pane's `dev-sync-core` skill): until
then the pane counts each line of the new format as one from a newer teamrig and skips it. The pane's gate
(`scripts/sync-core.ts --formats`) fails while its copy trails `main`, so the pane cannot ship behind it.

## The local gate
CI (`.github/workflows/ci.yml`) runs on each pull request and each push to `main` (every job would skip if the
repository were made private again, where GitHub Actions minutes bill). Its `every check passed` job passes only when
every other job did: the one check `main` requires (see [Pull requests](#pull-requests)). Its first job, `change
kind` (`tools/ci/change-kind.ts`), names what the change touches: `docs` when every changed file is a top-level
Markdown file or under `docs/`, `design` when every one is in the design notes folder, docs/design, else `code` (and `code` when there
is no base to compare with). It runs the base commit's copy of that tool, never the change's own, so a pull request
that edits `tools/ci` cannot name itself docs; a base from before the tool is `code`. A `docs` change runs the commit checks (scrub, DCO, size rule, subjects, dependency
review) and, on ubuntu alone, the build, the docs' specs, the pictures, the config reference, the parity page and the doc links; a
`design` change runs the commit checks and the doc links; a `code` change runs everything on every OS (the test
matrix's systems come from `change kind`, `TEST_SYSTEMS` in that file). Each job still runs and skips only its steps,
so `every check passed` reads a pass from each. Before that, the
`pre-push` hook that `npm ci` sets proves the commit being pushed (`tools/ci/local.ts`; the lists are
`tools/ci/local-checks.ts`). `node tools/ci/local.ts` and `npm run check` run every check CI runs, all but the
dependency review, which reads GitHub's dependency graph ([Security checks](#security-checks)):
- It refuses a push to `main`, before any check: every change lands through a pull request. On GitHub,
  the `main` ruleset refuses the same push from a clone without the hooks: it has no bypass actor, so no one can
  change main outside a pull request (see [Rules on `main`](#pull-requests)).
- It proves a committed tree: it refuses uncommitted changes, and a pushed commit that is not checked out.
- It stops at the first failing check and prints its output.
- A pass is recorded in the clone's git folder (`local-ci/<tree>.json`, shared by its worktrees), so a tree is
  checked once; a new commit is checked again. Only the runner writes a record: the pass-record guard refuses a
  session's own write of one (`hook pass-record-guard`).
- It cannot be skipped: never push with `--no-verify`.
- **Light checks** (the pre-push default): when the repository's entry in `tools/ship/repos.json` has the `ci` gate,
  a push to any branch but `main` runs the pre-push checks, about 45 s: the scrubs of the tree and the commits, the
  DCO sign-off, the size rule, the commit subjects, the typecheck, the build, the plugin's tests
  and the docs checks. GitHub CI is the full gate: the whole suite with its coverage gate, the dist checks and the
  fresh install run there, on every OS, before anything lands. The build writes the dist the plugin's tests load,
  which main does not track, so it leaves the checkout clean. A light pass is recorded apart
  (`local-ci/light/<tree>.json`), never taken for a full or a short one; a full pass counts as a light one. A push
  to `main`, and a repository with the `local` gate, run every check as above.
- **Short checks** (off by default): when the repository's entry in `tools/ship/repos.json` says
  `"mergeChecks": "changed"`, which needs the `ci` gate, a push to any branch but `main` runs only the short checks:
  the scrub, the DCO sign-off, the size rule, the commit subjects, the typecheck and the specs beside the changed
  files (`foo.ts` brings `foo.test.ts`, a changed spec runs itself). A change to the gate itself (`.githooks/`,
  `.github/`, `tools/ci/`, `tools/ship/`, `src/push-guard/`, `package.json`, the lockfile or a `tsconfig*.json`) runs
  every check instead. `tools/ship/ship.ts --merge` proves the tree the same way in place of the typecheck,
  coverage gate and full run, then pushes and merges once the required CI checks pass, so the merge holds the ship
  slot only for those steps. A short pass is recorded apart (`local-ci/short/<tree>.json`), never taken for a full
  one; a full pass counts as a short one. A run without `--merge`, and every repository left at `"full"`, run every
  check as above.

It runs on one machine and one Node, so a failure that only another OS or Node version shows waits for CI's test
matrix.

## Security checks
- **Dependency review**: CI's `dependency review` job fails a pull request that adds or changes a dependency (an
  npm package or a GitHub Action) with a known advisory, of any severity, dev dependencies included. It is one of
  the jobs `every check passed` needs, so such a pull request cannot merge.
- **CodeQL** (`.github/workflows/codeql.yml`) scans the TypeScript on each pull request that changes more than
  Markdown and `docs/`, each push to `main` and weekly. Its findings show in the Security tab and on the pull
  request; it is not a required check, so read them.
- **Dependabot** (`.github/dependabot.yml`) proposes npm and GitHub Actions updates weekly, one grouped pull
  request per ecosystem, and never a release younger than 14 days. A proposal is never merged as it comes: check
  the exact version against the advisories and its publish date, land it as your own signed-off commit (its
  commits carry no `Signed-off-by:` line, so the DCO gate fails its pull request), and close the proposal. The
  14 days hold version updates only: a security update for an advisory comes at once, and is landed the same way.
- **Every action is pinned** to a full commit SHA with its version in a comment (`tools/ci/security-workflows.test.ts`
  holds every workflow to it), so a moved tag cannot change what runs.
- **A vulnerability** is reported privately, never in an issue: [SECURITY.md](SECURITY.md).

## Branches and releases
- Every change is its own branch off `main` and lands through a pull request once every check
  passes on its head (the local gate before the push, CI after it); it is rebase-merged and the branch is deleted.
- A branch is named `<type>/<id>-<slug>` (Conventional Branch): `feat`, `fix`, `docs`, `chore`, `refactor`,
  `hotfix` or `release`, the task or issue id, then a short lowercase kebab slug, such as `fix/t12-login-loop`.
  `teamrig worktree add --task <id>` names it so. A security fix's branch names the hardening, never the flaw
  ([SECURITY.md](SECURITY.md)): name it yourself when the task's title tells the flaw. To ship a branch again after its commits reached origin, rename
  it with `-b` added (`fix/t12-login-loop-b`), never a force-push. Branches named before keep their names.
- Each commit is one logical change. The `size rule` (`tools/ci/size-rule-cli.ts`, run by the local gate, CI
  and `npm run check`) fails a commit over 400 changed non-test lines or 15 non-test files whose message has
  no `Large-commit: <reason>` line: the push guard's rule at its defaults, so a pull request meets it too.
- Each commit subject is a Conventional Commit, `<type>(<area>): <what>` with the area optional, such as
  `fix(ship): ...` or `docs: ...`; the types are `feat`, `fix`, `perf`, `refactor`, `docs`, `test`,
  `build`, `ci`, `chore` and `revert`, and a `!` before the colon marks a change that breaks how people use
  teamrig. The release workflow raises the version from these subjects, and a pull request is rebase-merged with its
  commits as they are, so the `commit subjects` check (`tools/ci/commit-subjects-cli.ts`, run by the local gate, CI
  and `npm run check`) fails a commit whose subject is not one, and says how to reword it.
- Nothing is pushed to `main` directly, and release tags are set only by the release workflow.
- The `release` workflow (`.github/workflows/release.yml`, run on each push to `main`) keeps one release pull request open
  through release-please (`release-please-config.json`): it raises the version in the plugin's `plugin.json` and
  `src/core/version.ts` and writes the notes. It merges like any pull request, through `tools/ship`: the lead approves
  a release task at the release pull request's head, and `node tools/ship/ship.ts merge <repo dir> --release T<id>
  --approved <sha>` merges it (skill `dev-ship-release`). That merge refuses a head holding anything but the version
  raises and the changelog's new notes, never opens the pull request, and asks for a new head's approval when main
  moved, since release-please rewrites the head on each push to main. Once it merged, the next run tags
  main `teamrig-v<version>` with the notes, builds the dist with a read-only token, and pushes main's commit with
  the dist on top to the `release` branch, tagged `v<version>` (`tools/release/publish.ts`). The marketplace entry
  installs from that branch (a `git-subdir` source on ref `release`), so main ignores `plugins/teamrig/dist` and no
  pull request carries one.
- Installs take the version in `plugins/teamrig/.claude-plugin/plugin.json`, not the newest commit:
  `claude plugin update` moves an install only when that version rises. A pull request never raises it: the release
  pull request does, from the commit subjects since the last release. While it is 0.x, a `feat` or a breaking
  change raises the minor, a `fix` or `perf` the patch. A spec (`tools/ci/release-workflow.test.ts`) holds
  `plugin.json`, `src/core/version.ts` and `.release-please-manifest.json` to one version, so a raise by hand
  fails, and another (`tools/lib/marketplace.test.ts`) fails a marketplace entry that gives a version of its own,
  which Claude Code ignores. How users update: [Updating the plugin](docs/how-it-works.md#updating-the-plugin).

## Issues
[Issues and pull requests](docs/issues-and-pull-requests.md) is the short way in, for people and their AI tools.
Each issue becomes a task teamrig tracks, so an issue carries the task's fields. Open one through a form: a blank issue
is turned off.

| Form | Its type label | Sections (all required unless marked) |
| --- | --- | --- |
| Bug report | `bug` | What happened, What was expected, Steps, Version (`teamrig --version`), OS |
| Task | `task` | What, Why, Done when, Risks |
| Feature request | `feature` | Problem, Proposal, Alternatives (optional), Risks |
| Design | `design` | Question, Context, Options, Proposal (optional), Risks; talk, not work, until agreed ([Design issues](#design-issues)) |

- **Title**: `<area>: <a plain sentence>`, such as `budget: the week line counts a retired session`.
- **Labels** are listed in `.github/labels.json`. The form sets the type. Maintainers and the GitHub watcher set
  the priority (`p1` to `p3`), the area (`area:cli`, `area:hooks`, ...) and the state (`needs-format`,
  `duplicate`, `teamrig`), which need triage rights.
- **Security problems** go through a private advisory, never a public issue: the issue chooser links it, and
  [SECURITY.md](SECURITY.md) says what to send.
- `tools/ci/github-format.ts` lists each form's sections and the pull request template's, and
  `tools/ci/github-format.test.ts` holds the forms, `labels.json` and the template to it.

## Design issues

A design issue, labelled `design`, is where we talk about how something should work before anyone builds it, in
place of a discussion forum. Open one with the Design form. Every contributor, and the agent working for them, may
join; agents follow [`dev-design-issue`](.claude/skills/dev-design-issue/SKILL.md).

- **Give your side with reasons**: a comment saying what you would do and why, what it costs and what it gives up,
  answering the earlier comments you disagree with. One comment per point, not a running log.
- **Nothing to take yet**: no claim, no assignee, no branch, no code and no pull request until the maintainer marks
  it agreed. teamrig shows no status label on a design issue and assigns it to no one.
- **Agreed**: the maintainer posts a comment starting `Agreed:` that sums up the decision, updates the issue body to
  it and takes the `design` label off, or opens the work as new issues linked to it. From then on it is work, taken
  like any other issue.
- **Never post sensitive data**, here or anywhere public (an issue, a comment, a pull request, a commit): no secret,
  token or key, no private path, host name or e-mail address, no private log, and no security hole. A security hole
  goes through a private report, as [SECURITY.md](SECURITY.md) says; a log goes in cut to the lines that matter, with
  every private value taken out.

### Design docs

Every design doc and study lives in [`docs/design/`](docs/design), never beside the user docs, so a design is not read
as how teamrig works today.

- **When**: write one after a design issue's `Agreed:`, or as a study an issue asks for before anything is agreed.
- **Its header**: the page opens with a status line, `Status: proposed`, `Status: accepted` or `Status: replaced by
  <link>`, with the date it was written and a link to its issue.
- **A record, not a living page**: a design doc is not kept current the way user docs are. When the design changes,
  its status line changes (to `accepted`, or to `replaced by` a newer doc), and what ships is described in the user
  docs.

## Pull requests
- **The description**: the template asks for What, Why, Reach (see [Where a change lives](#where-a-change-lives)), Changes, Risks (see
  [What a change is held to](#what-a-change-is-held-to)), Old-code proof (for a fix, the regression test that fails
  on the old code), Tests and Issue (`Fixes #<n>` or `Refs #<n>`), then the checklist.
- **From a fork**: fork the repository, branch off its `main`, and open the pull request against this repository's
  `main`. CI runs it with no secrets and a read-only token, and an outside contributor's run waits for the
  maintainer to approve it.
- **Your commit e-mail**: the `Signed-off-by:` line carries your commit e-mail, and the scrub refuses an e-mail
  address in a commit message unless it is one of GitHub's no-reply addresses. Before your first commit, set the
  no-reply address GitHub shows under Settings, Emails: `git config user.email <id>+<user>@users.noreply.github.com`.
- **A flaky test leg**: the merge re-runs a test leg listed `flaky` in `tools/ship/repos.json` once when only it
  failed, and reads the checks once more after a GitHub server error or timeout; a second failure stops the merge.
- **A leg a docs run leaves out**: a check listed `conditional` in `tools/ship/repos.json` (teamrig's windows and
  macOS test legs) is one the run makes only for some changes; once `every check passed` passed without it, the
  merge stops waiting for it, and one that does show must pass.
- **The merge queue** (off by default): when the repository's entry in `tools/ship/repos.json` says `"queue": true`,
  which needs the `ci` gate, the merge puts the pull request in GitHub's merge queue at the checked head once its
  checks pass, in place of its own merge call, and waits for the queue to land it. The queue orders the landings,
  so the merge takes no landing turn. A pull request already queued is waited on, not queued again. One the queue
  lets go unmerged stops the merge with GitHub's reason and the failed merge group run's jobs; one still queued at
  the timeout stays queued, and a merge run again waits on it.
- **Review**: a code owner (`.github/CODEOWNERS`: the maintainer) reviews the code and approves the last push, and a
  new push dismisses an approval given before it. The reviewer holds it to
  [What a change is held to](#what-a-change-is-held-to) and declines a wrong direction. On a threshold, limit or trigger the reviewer asks "can this
  still fire?" and wants the spec of it firing in the real flow ([Tests](#tests)). A change to the git hooks, CI, the scrub or teamrig's guards
  (`.githooks/`, `.github/`, `tools/scrub/`, `tools/ci/`, `src/hooks/`, `src/push-guard/`, `src/secret-guard/`,
  `src/package-guard/`, `src/permissions/`) also gets a security review.
- **Rules on `main`**: `.github/rulesets/` holds the repository's rulesets, the two for `main` and the three for
  releases, imported under Settings, Rules, Rulesets. `main` lets no one push, force-push or delete it and takes a change only through a pull request,
  rebase-merged once its `every check passed` check passed on the newest `main`; `main review` asks a code owner
  to approve the last push, which only the maintainer's own pull requests skip. `tools/ci/rulesets.test.ts` holds
  them to `ci.yml` and `.github/CODEOWNERS`.
- **Rules on releases**: the `release` branch, which every install reads, and a `v<version>` tag, which an install
  can pin, only the release workflow's publish job may create or push (`release`, `release tags`): it pushes with a
  deploy key, the rulesets' one bypass actor, whose private half is a secret of the `release` environment, which only
  `main` may use. No one moves or deletes a `v<version>` tag, nor the `teamrig-v<version>` tag release-please puts
  on `main` (`release-please tags`).

## Scrub checks
Two checks keep private data out of the history:
1. **Generic** (in this repo, run by the hooks, the local gate and CI): absolute home paths, e-mail addresses,
   IP addresses, internal host names and the secret shapes teamrig's secret guard refuses: common tokens,
   credentials in a URL or an Authorization or API key header, and literals given to a secret-like name.
2. **Private denylist** (optional, never committed): a file of your own terms, wired in with
   `git config --local teamrig.scrubDenylist <path>`. Once configured, the hooks fail closed if
   the file is missing. The scrub runs only inside the repo's work tree, where that setting is read, and refuses
   anywhere else rather than pass on the generic check alone.

Write test data that looks like a secret by building it at runtime (for example
`'ghp' + '_' + 'x'.repeat(36)`), so the source never holds the literal.
