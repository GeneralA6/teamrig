# GitHub sync

`teamrig issue sync` brings the issues of your GitHub repositories into the task list, one way only. Each open issue
written by the repository's people, or accepted by them ([Whose issues become tasks](#whose-issues-become-tasks)),
becomes a task (source `github`, ref `gh:<owner>/<name>#<number>`), and its title, description (the issue's body),
priority and open or closed state follow GitHub on every run. The sync never goes the other way: it never creates,
edits, comments on or closes anything on GitHub, and a task added with `teamrig add` stays on your machine. The
writes are all run by hand: `teamrig issue migrate` moves tasks you choose to new issues, once
([Moving your tasks to issues](#moving-your-tasks-to-issues)), `teamrig issue comment`, `teamrig issue label`
and `teamrig issue close` answer, label or close one issue or pull request
([Commenting on, labelling and closing](#commenting-on-labelling-and-closing)), and `teamrig issue links` puts the
task tree on the issues ([Linking issues as the task tree](#linking-issues-as-the-task-tree)). GitHub is the
only host teamrig writes to so far.

Setting it up takes three steps: list the repositories, give teamrig read access to their issues, then preview and
write. After that it runs on its own every 15 minutes while your sessions work, and reminds you of an issue waiting
long for your answer ([Answer times](#answer-times)).

## 1. List the repositories

Add a `github` block to the team config (`~/.teamrig/teams/<team>/config.json`):

```json
"github": {
  "repos": ["acme/web", "acme/api", "globex/site"],
  "sessions": { "acme/web": "web", "acme/api": "api", "globex/site": "web" },
  "owners": { "octocat": "api" },
  "closedDays": 14,
  "everyMinutes": 15
}
```

| Key | What it does |
| --- | --- |
| `repos` | The repositories to read, as `owner/name` (at most 20). Empty turns the sync off. |
| `sessions` | Optional. The session that owns each repository's issues, so each session sees the issues of its own repositories. One session can own several. |
| `owners` | Optional. A GitHub login to a session: an issue assigned to that login goes to that session, whatever its repository. |
| `closedDays` | How many days back closed issues are read, to finish their tasks. Default 14. |
| `everyMinutes` | How often it runs on its own, in minutes (0 to 1440). Default 15; 0 leaves it to `teamrig issue sync --yes`. |
| `acceptLabel` | Optional. The label that lets an issue by someone outside the repository become a task ([below](#whose-issues-become-tasks)). Default `teamrig`. |

Who owns a new issue's task: the session of its first assignee listed in `owners`; else its repository's session in
`sessions`; else the lead. After the import the owner is the team's: reassigning the task in teamrig sticks. So is
closing it: a task the team sets done or dropped while its issue is open stays closed until the issue changes on
GitHub after that (reopened, edited or commented on).

### Whose issues become tasks

Anyone can open an issue on a public repository, so teamrig takes only the issues of people you trust:

- **The repository's people.** An issue whose author GitHub ties to the repository as its owner, a member of its
  organisation or a collaborator becomes a task at the next sync.
- **Anyone else's, once accepted.** An issue by any other author (one with a merged pull request too) waits until
  someone other than its author adds the `acceptLabel` label, `teamrig` by default (any case). Only people with
  triage rights can label an issue; a label put on by a bot, a workflow or an issue template does not count.
- **A workflow's issue waits too.** An issue a GitHub Actions workflow or another app opens waits for the label like
  an outsider's, since a workflow may copy an outsider's text into it.
- **An edit undoes the accept.** When the title or body changes at or after the label went on, whoever edited it,
  the issue is not accepted any more. Once you have read the new text, remove the label and add it again.

An issue that counts neither way writes nothing. A task the sync already added for one keeps its text: its priority
and open or closed state still follow GitHub, its title and description stay as they are.

## 2. Give teamrig read access

teamrig reads issues through the GitHub CLI, [`gh`](https://cli.github.com). For each owner (the `acme` in
`acme/web`) it uses:

- **a token saved for that owner**, when there is one: recommended, and needed when your repositories belong to
  more than one owner;
- **else the `gh` login** (`gh auth login`), which works when that account can read the issues of every listed
  repository.

A token is saved, but the credential store cannot read it (a locked keyring, for one): the command stops for that
owner with a `FAILED` line naming the store and the fix, and never falls back to the `gh` login, which may reach
more than the token was given. `teamrig issue sync` reads the other owners on.

### What each command needs

Give the token only what the commands you run need:

| Command | Repository permissions |
| --- | --- |
| `teamrig issue sync` | **Issues: Read-only** |
| `teamrig issue migrate` | **Issues: Read and write** |
| `teamrig issue comment`, `teamrig issue label`, `teamrig issue close` | **Issues: Read and write** and **Pull requests: Read and write** (a pull request's comments, labels and state are written through its issue) |
| `teamrig issue links` | **Issues: Read-only** for the preview, **Issues: Read and write** with `--yes` |

### Why one token per owner

A fine-grained GitHub token belongs to one *resource owner*: your personal account or one organisation. It can never
reach the repositories of another owner. So a team that reads `you/tool` and `your-org/app` creates two tokens, one
for each owner. teamrig finds each by its name, `teamrig-gh-<owner>`, so no config names them.

### Create a token

Do this once per owner:

1. On GitHub: **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Token name**: anything, e.g. `teamrig read issues`. **Expiration**: 90 days is a fair balance.
3. **Resource owner**: the owner of the repositories, e.g. `acme`.
4. **Repository access**: **Only select repositories**, and pick the ones in `github.repos`.
5. **Permissions → Repository permissions**: what [each command needs](#what-each-command-needs), for the sync
   alone **Issues: Read-only**. GitHub adds **Metadata: Read-only** by itself. Give it nothing else.
6. **Generate token** and copy it. GitHub shows it only once.

For an organisation, an organisation owner may have to approve the token before it works; until then GitHub refuses
it.

### Save it

Save the token in your system's credential store under `teamrig-gh-<owner>`, the owner in lowercase. Each command asks
for the token and shows nothing as you paste it. Run it in a terminal window of your own:

| System | Save | Remove |
| --- | --- | --- |
| Windows (Credential Manager) | `cmdkey /generic:teamrig-gh-acme /user:teamrig /pass` | `cmdkey /delete:teamrig-gh-acme` |
| macOS (keychain) | `security add-generic-password -U -s teamrig-gh-acme -a teamrig -w` | `security delete-generic-password -s teamrig-gh-acme` |
| Linux (Secret Service, `libsecret-tools`) | `secret-tool store --label=teamrig-gh-acme service teamrig-gh-acme` | `secret-tool clear service teamrig-gh-acme` |

On Linux without `secret-tool`, teamrig reads through the `gh` login.

## 3. Preview, then write

```sh
teamrig issue sync          # shows what it would do, writes nothing
teamrig issue sync --yes    # writes it
```

The preview is also the check that access works. It says once per owner how that owner's repositories are read:

```text
ACCESS acme: read with the token saved as teamrig-gh-acme
REPO acme/web: 2 to add, 0 to change, 5 unchanged
ADD new gh:acme/web#7 p1 web: "Fix the login redirect"
ADD new gh:acme/web#9 p2 web: "Add search to the docs"
LEFT OUT acme/web: 1 open issue(s) by people outside the repository wait for someone to add the "teamrig" label: #12
REPO acme/api: 0 to add, 0 to change, 3 unchanged
ACCESS globex: read with the gh login; no token saved as teamrig-gh-globex
REPO globex/site: 1 to add, 0 to change, 0 unchanged
ADD new gh:globex/site#4 p2 web: "Broken footer link"
PREVIEW nothing was written; teamrig issue sync --yes writes the above as github
```

A repository that cannot be read gets a `FAILED` line saying what to fix; its tasks stay as they are and the other
repositories are read on. A `LEFT OUT` line names, by number only, the open issues by people outside the repository
that no one accepted yet (at most 20, then how many more); their text is never printed. `teamrig issue sync --repo
acme/web` reads one repository only.

## Then it runs on its own

Once the repositories are listed, nobody needs to run it. When a session of the team ends a turn, its Stop hook
checks whether `everyMinutes` (15) have passed since the last sync; if so, it starts `teamrig issue sync --auto` hidden
in the background, once for the whole team, and the turn goes on as usual. Nothing keeps running between syncs, so
while every session is idle nothing is read; the next turn that ends catches up.

- Each session with new tasks gets one inbox line, for example
  `github: GitHub sync added 1 task(s) for you: T42 gh:acme/web#7 "Fix the login redirect"`.
- `teamrig list` shows such a task with its issue: `T42 open, p1, owner web, from gh:acme/web#7 | Fix the login redirect`.
- A repository that cannot be read is told to the lead's inbox once, with the `FAILED` reason, and again when every
  repository reads again; it is not repeated at every run.
- An outsider's issue left out for the first time is told to the lead's inbox once, by ref only, for example
  `github: GitHub sync left out 1 new open issue(s) by people outside the repository: gh:acme/web#12; add the
  "teamrig" label to one on GitHub to make it a task at the next sync`.

## Answer times

Each sync that writes (`--yes` or the automatic one) also times how long each open issue has waited for an answer of
yours, so nobody outside waits unseen. An issue waits from the first post by someone outside the repository after your
last reply (a member's, owner's or collaborator's post counts as yours; a bot's counts as nobody's), so a "any news?"
follow-up does not restart the wait. The target depends on the issue:

| Issue | Answer within |
| --- | --- |
| labelled `security` | 4 h |
| labelled `bug` | 24 h |
| on an issue one of your tasks tracks | 24 h |
| any other: a feature ask or a question | 72 h |

- At 75% of the target, the session that answers it (the owner of the task tracking it, else the one its import
  would go to) gets one inbox line, without a wake, for example `github: GitHub gh:acme/web#9 (bug) has waited 18 h for
  an answer of ours, since 11-15 08:00 UTC; answer it in words on GitHub by 11-16 08:00 UTC, its 24 h target, or
  GH-LATE goes to the lead`.
- At 100%, `teamrig check` shows the lead `GH-LATE gh:acme/web#9 (bug, web) has waited 25 h ...`, once per wait.
- Your answer, or the issue closing, stops the clock. A repository that cannot be read keeps its clocks until it can.
- `teamrig stats` shows the W your GitHub-linked tasks used on its `GITHUB` line. That number stays in teamrig:
  nothing is posted to GitHub.

The clocks live in `state/github-clocks.json` in the team's folder. Reading them costs no GitHub call: `check` reads
what the last sync kept.

`"everyMinutes": 0` turns the automatic sync off, and `TEAMRIG_GITHUB=off` turns every sync off on one machine.
`teamrig issue sync --yes` still works at any time.

## Moving your tasks to issues

To move a team's task list to GitHub, say before a repository goes public, `teamrig issue migrate` opens one issue per
task you choose. Issues are public on a public repository, so you write each one's wording yourself, in a row file
of JSON lines:

```text
{"id": "T12", "decision": "issue", "repo": "acme/web", "type": "bug", "priority": "p1", "title": "Login redirect loops", "body": "After a sign-in the page redirects back to the login form."}
{"id": "T15", "decision": "local", "reason": "names a customer"}
```

```sh
teamrig issue migrate rows.jsonl --out preview.md    # writes nothing but the preview
teamrig issue migrate rows.jsonl --yes               # opens the issues
```

- **No task ids on GitHub.** A task id numbers your team's own list and means nothing to a reader of the issue, so
  a row whose title or body names one (`T12`, `bravo/T12`) refuses the file; link other issues by `#number`. The
  issue carries only its title, body and labels: the task finds its issue through its ref, which is never posted.
- **Preview first.** Without `--yes` nothing is written. `--out` writes a page with every issue in full (repository,
  labels, title, body), the tasks kept local with their reasons and the rows it skips, for a reviewer. The output
  counts the issues to open and names the live tasks no row covers (`NO ROW`).
- **Each issue is linked.** `--yes` opens the issues in row order, each labelled with its type and priority, and sets
  the task's ref to `gh:<owner>/<name>#<number>`, so the sync that follows adds no second task. A task whose ref is
  not an issue gets its issue in the ref's place (`REPLACES` in the preview); the update's note keeps the old ref,
  so the task's history still has it.
- **Safe to rerun.** The first failure stops the run (`FAILED` or `REFUSED`, then `STOPPED`); fix the cause and run it
  again: a task that holds its issue already is skipped, and so is a finished task or a repository not in
  `github.repos`.
- **Write access, for this run only.** The token of each owner needs **Issues: Read and write**. Set it back to
  Read-only once the issues are open, unless you comment on, label or close issues with it; the sync needs nothing
  more.

## Commenting on, labelling and closing

`teamrig issue comment` posts one comment on an issue or pull request, `teamrig issue label` adds and takes off its
labels, and `teamrig issue close` closes one, first posting its `--comment` when given; a pull request closes
unmerged. `--reason completed`, `not-planned` or `duplicate` says why it closed (GitHub keeps it on an issue only);
`--duplicate-of` closes it as a duplicate of another issue of the same repository, which GitHub links as the
original. Each names its target as `owner/name#number`:

```sh
teamrig issue comment acme/web#7 --body "Fixed in #9, thank you."
teamrig issue label acme/web#7 --add "type: bug,p1" --remove "needs triage"
teamrig issue close acme/web#12 --comment "Merged as #14 with your commits credited. Thank you!"
teamrig issue close acme/web#15 --duplicate-of acme/web#7
```

```text
ACCESS acme: writes with the token saved as teamrig-gh-acme
COMMENTED acme/web#12
CLOSED acme/web#12
```

- **Only the team's repositories.** A repository not in `github.repos` is refused before anything runs.
- **Checked text.** An empty text, one past 65,536 characters, one that looks like it holds a secret, one that holds
  private data (a path inside a home folder, an e-mail address, an IPv4 address or an internal host name, the shapes
  teamrig's own commits are scrubbed for), or one that names a task id (`T12`: link issues by `#number`) is refused,
  and nothing is posted.
- **Nothing half done.** When the comment fails, nothing is closed. When the close fails after the comment was
  posted, the `FAILED` line says so: rerun `teamrig issue close` without `--comment`, so the comment is not posted
  twice.
- **No new labels.** Each label to add must already be one of the repository's: teamrig reads it first and changes
  nothing when one is missing, as GitHub would make a new label from a typo. Make it on GitHub first. Labels to add
  go in one call, then each to take off in turn; the first failure stops it and says what it already changed.
- **Access.** The same token or `gh` login as the sync, which needs the [write permissions](#what-each-command-needs);
  a `FAILED` line names the permission a token lacks. `TEAMRIG_GITHUB=off` writes nothing.

## A pull request in conflict

When GitHub marks a pull request as conflicting, `teamrig pr conflicts` names the files to resolve. Run it in a
clone of the repository: it fetches the pull request's head (a fork's too) and `origin`'s newest base, and merges them
in git's object store alone, so no local branch, file or index of the clone changes (the fetch only drops the
remote-tracking refs of branches deleted on `origin`) and nothing is written to GitHub.

```sh
teamrig pr conflicts acme/web#7
```

```text
CONFLICTS acme/web#7 (head d00d5ee) against origin/main (b4e2a91): 2 files
  src/a.ts
  docs/b.md
To land it: rebase its branch onto origin/main and resolve these files.
```

For an outside pull request, post those files and the rebase in a comment (`teamrig issue comment`). A team pull
request is re-shipped by its owner on the newest base under a new branch name, never force-pushed. `--base` names
the branch the pull request targets when it is not `origin`'s default; the fetch uses git's own access to `origin`,
not a token.

## Showing each task's status on its issue

`teamrig issue sync --push` plans the other way: for each issue a task holds (its ref `gh:owner/name#number`), what
makes the issue show the task's status. On its own it only plans: it reads the issues, like the sync, and writes
nothing. With `--yes` it sends the plan: each change gets a `SET` line, and a final `PUSHED` line counts the
changes and writes.

```text
ACCESS acme: read with the token saved as teamrig-gh-acme
PUSH acme/web: 3 to change, 3 unchanged, 1 closed on the host while the task is active
LABEL acme/web#7 T41 in-progress: add status:in-progress, take off status:triaged
CLOSE acme/web#9 T42 done: close as completed, take off status:in-review
ASSIGN acme/web#11 T43 open: assign acme
KEPT acme/web#5 T30 open: closed on the host (not_planned) while the task is active; the push never reopens an issue, so set the task to match or reopen the issue
PREVIEW nothing was written; a push would send 5 write(s) now, at most 40 a run, and plan the rest again on the next
```

- **One status label.** `open` shows `status:triaged`, `in-progress` `status:in-progress`, `waiting`
  `status:waiting`, `verifying` `status:in-review`; any other `status:` label comes off. Done closes the issue as
  completed, dropped as not planned.
- **Planned against GitHub as it is.** The plan compares each task with its issue as listed now, so a label someone
  changed by hand is set back, and a run that stopped half way is planned again whole.
- **A person's close stands.** An issue closed while its task is active is never reopened: a `KEPT` line names it.
- **Someone answers for it.** An open issue no one is assigned to gets an assignee: the login `github.owners` maps
  to the task's owning session, else the account that owns the repository (sessions are not GitHub users). An issue
  a person assigned keeps its assignees; the push takes none off. Each login is read first: one the repository may
  not assign (not a person with access to it) gets an `UNASSIGNED` line and its issues keep their label changes, as
  GitHub would drop it silently and every run would send it again.
- **Within GitHub's limit.** At most 40 writes a run, half GitHub's 80 a minute, shared by every repository in
  `github.repos` order; the rest waits for the next run.
- **On its own, once you turn it on.** With `"statusPush": true` in the team config's `github` block, the
  [automatic sync](#then-it-runs-on-its-own) sends the push after each import, so no session runs it. Each run then
  sends fewer writes when the sync runs often, so an hour of runs sends at most 250, half GitHub's 500 an hour (every
  15 minutes: 40 a run; every 5: 20). It sends labels and assignees only: a close is the one write a person reads as a decision,
  so the automatic push prints it as a `HELD` line and leaves it to a session's `teamrig issue sync --push --yes`.
  A failed write is told to the lead's inbox like a repository that cannot be read. It is off by default: read `teamrig issue sync --push` first, and give the token **Issues: Read and write**.

## Linking issues as the task tree

`teamrig issue links` puts the task tree on the issues of `github.repos`. A task planned after another (`--after`),
both mirrored in one repository, makes its issue blocked by the other's on GitHub. A whole is planned after its
parts, so a part planned before exactly one whole becomes that whole's sub-issue as well. Without `--yes` it reads
the links GitHub has and shows what it would add:

```sh
teamrig issue links
teamrig issue links --yes
```

```text
ACCESS acme: read with the token saved as teamrig-gh-acme
REPO acme/web: 1 issue(s) to change, 2 link(s) to add, 0 already there
LEFT acme/web: 1 edge(s) to another repository are left for a person
BLOCKED-BY #9 by #10
SUB-ISSUE #10 under #9
PREVIEW nothing was written; teamrig issue links --yes adds the links above
```

- **Adds only.** It never removes or moves a link. A part GitHub already shows under another parent gets only its
  blocker, and a part of several wholes gets only blockers, as an issue has one parent. The `LEFT` line counts what
  it leaves for a person, an edge to another repository among them.
- **Rerun to finish.** It stops a repository at its first failed link (a refused token or a rate limit would refuse
  the rest too); a rerun reads GitHub again and adds only what is still missing.
- **The task list is only read.** The links live on GitHub; nothing changes in teamrig.

## Renewing a token

When a token expires, GitHub refuses it and the `FAILED` line says so. Regenerate it on GitHub (the token's page has
**Regenerate token**) and save it again with the same command: saving under the same name replaces the old one.
Changing a token's permissions or repositories on GitHub keeps the token text the same, so there is nothing to save
again.

## When something fails

| The `FAILED` line says | What it means | Fix |
| --- | --- | --- |
| `the token saved as teamrig-gh-acme may not read the issues of acme/web` | The token sees the repository but has no Issues permission. | On GitHub, edit the token: what [each command needs](#what-each-command-needs). |
| `acme/web is not visible to the token saved as teamrig-gh-acme` | The repository is not one the token was given, or the name is wrong. | Check `github.repos`; on GitHub, add the repository to the token. |
| `GitHub refused the token saved as teamrig-gh-acme (expired or revoked?)` | Expired, revoked or not yet approved by the organisation. | Regenerate it and save it again, or ask an organisation owner to approve it. |
| `... is not visible to the gh login` / `the gh login may not read the issues` | No token is saved for that owner, and the `gh` account cannot read it. | Save a token for the owner (step 2). |
| `gh is not logged in to GitHub` | No token for that owner and no `gh` login. | Save a token, or run `gh auth login`. |
| `gh, the GitHub CLI, is not installed` | `gh` is missing. | Install it from [cli.github.com](https://cli.github.com). |
| `could not read teamrig-gh-acme from ...` | The token is saved, but the credential store could not be read (a locked keyring, for one). Nothing ran for that owner: teamrig never uses the `gh` login in a saved token's place. | Unlock the store and rerun, or save the token again. |

## Safety

- **Read-only sync.** The sync runs only the issue queries teamrig ships, word for word, through `gh api graphql`, so
  a token with **Issues: Read-only** is all it needs. Of an issue's newest 20 comments it reads only when each was
  posted, its author's tie to the repository and whether that author is a bot: never their text or login. Any other
  `gh` command or query is refused in code, except
  the writes, each run by hand on a repository in `github.repos`: `teamrig issue migrate`'s create of one issue
  (`gh api repos/<owner>/<name>/issues -X POST` with its title, body and labels only), `teamrig issue comment`'s
  one comment (`.../issues/<number>/comments -X POST` with its body only), `teamrig issue label`'s read of one label
  (`repos/<owner>/<name>/labels/<label>`), add (`.../issues/<number>/labels -X POST` with its labels only) and take
  off (`.../issues/<number>/labels/<label> -X DELETE`), `teamrig issue close`'s close
  (`.../issues/<number> -X PATCH` with `state=closed` and its `state_reason` only, a duplicate's also with the
  original's `duplicate_issue_id`, digits only) and the read of that original (`.../issues/<number> -X GET`, no
  field), the status push's read of whether one login may be assigned (`repos/<owner>/<name>/assignees/<login>`)
  and its assign (`.../issues/<number>/assignees -X POST` with logins only, never a removal), and
  `teamrig issue links`'s one link (`.../issues/<number>/sub_issues` or `.../dependencies/blocked_by`, `-X POST`
  with one issue id only). No link is ever removed.
- **Never on disk in the clear.** The token lives in the system's credential store, encrypted under your login. It
  is never in the team config, a command line, a log or teamrig's output: teamrig hands it to `gh` as `GH_TOKEN` for
  that one run.
- **Same trust as the `gh` login.** Any program running as you can read your credential store, just as it can use
  your `gh` login. Keep each token to the repositories the team syncs.
- **Issue text is outside input.** Anyone who can open an issue writes its title and body, so an outsider's issue
  becomes a task only once accepted ([Whose issues become tasks](#whose-issues-become-tasks)); teamrig prints titles
  quoted, as data, never as instructions. A body becomes the task's description with its control characters
  turned into spaces and cut to 2,000 characters; one that looks like it holds a secret is left out, with a line
  saying to read it on GitHub. Sessions read descriptions as data, never as instructions.
- **Off switch.** `TEAMRIG_GITHUB=off` turns the sync off on one machine.
