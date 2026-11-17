# GitHub sync

`teamrig issue sync` brings the issues of your GitHub repositories into the task list, one way only. Each open issue
written by the repository's people, or accepted by them ([Whose issues become tasks](#whose-issues-become-tasks)),
becomes a task (source `github`, ref `gh:<owner>/<name>#<number>`), and its title, description (the issue's body),
priority and open or closed state follow GitHub on every run. The sync never goes the other way: it never creates,
edits, comments on or closes anything on GitHub, and a task added with `teamrig add` stays on your machine. The
writes are all run by hand: `teamrig issue migrate` moves tasks you choose to new issues, once
([Moving your tasks to issues](#moving-your-tasks-to-issues)), `teamrig issue comment`, `teamrig issue label`,
`teamrig issue edit` and `teamrig issue close` answer, label, rewrite the description of or close one issue or pull
request ([Commenting on, labelling and closing](#commenting-on-labelling-and-closing)), and `teamrig issue links` puts the
task tree on the issues ([Linking issues as the task tree](#linking-issues-as-the-task-tree)). GitHub is the
only host teamrig writes to so far. Each run also reads the repositories' pull requests and tells each session what
happened to its own ([Pull request news](#pull-request-news)), tells it when someone on GitHub names one of your
users with an `@` ([Mentions of your users](#mentions-of-your-users)), and tells each task's owner, and each session
following the item, the new comments, reviews, labels and closes of its issue or pull request
([Activity on your tasks](#activity-on-your-tasks)).

Setting it up takes three steps: list the repositories, give teamrig read access to their issues, then preview and
write. After that it runs on its own within a minute of a change on GitHub while your sessions work, and reminds you of an issue waiting
long for your answer ([Answer times](#answer-times)).

## 1. List the repositories

Add a `github` block to the team config (`~/.teamrig/teams/<team>/config.json`):

```json
"github": {
  "repos": ["acme/web", "acme/api", "globex/site"],
  "sessions": { "acme/web": "web", "acme/api": "api", "globex/site": "web" },
  "owners": { "octocat": "api" },
  "closedDays": 14,
  "probeSeconds": 60
}
```

| Key | What it does |
| --- | --- |
| `repos` | The repositories to read, as `owner/name` (at most 20). Empty turns the sync off. |
| `sessions` | Optional. The session that owns each repository's issues, so each session sees the issues of its own repositories. One session can own several. |
| `owners` | Optional. A GitHub login to a session: an issue assigned to that login goes to that session, whatever its repository. |
| `areaOwners` | Optional. A label to a session, such as `"area:cli": "cli"`: an issue with that label goes to the session of its area, whatever its repository. Matched without case; when an issue carries several, the first listed here wins. |
| `closedDays` | How many days back closed issues are read, to finish their tasks. Default 14. |
| `probeSeconds` | How often it asks GitHub whether a repository changed, in seconds: 0, or 30 to 3600. Default 60; 0 leaves the sync to `teamrig issue sync --yes`. |
| `acceptLabel` | Optional. The label that lets an issue by someone outside the repository become a task ([below](#whose-issues-become-tasks)). Default `teamrig`. |

Who owns a new issue's task: the session of its first assignee listed in `owners`; else the session of its first
label listed in `areaOwners`, so a person's pick beats the area; else its repository's session in `sessions`; else
the lead. After the import the owner is the team's: reassigning the task in teamrig sticks. So is
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

teamrig reads and writes issues through the GitHub CLI, [`gh`](https://cli.github.com), with **a token saved for
each owner** (the `acme` in `acme/web`), handed to `gh` for that run only. It never uses the `gh` login
(`gh auth login`) in its place, which may reach more than the token was given: an owner with no saved token, or
one the credential store cannot read (a locked keyring, for one), stops with a `FAILED` line naming the store and
the fix, and nothing runs for it. `teamrig issue sync` reads the other owners on.

### What each command needs

Give the token only what the commands you run need:

| Command | Repository permissions |
| --- | --- |
| `teamrig issue sync` | **Issues: Read-only** and **Pull requests: Read-only** |
| `teamrig issue migrate` | **Issues: Read and write** |
| `teamrig issue comment`, `teamrig issue label`, `teamrig issue edit`, `teamrig issue close` | **Issues: Read and write** and **Pull requests: Read and write** (a pull request's comments, labels, description and state are written through its issue) |
| `teamrig issue links` | **Issues: Read-only** for the preview, **Issues: Read and write** with `--yes` |

### Why one token per owner

A fine-grained GitHub token belongs to one *resource owner*: your personal account or one organisation. It can never
reach the repositories of another owner. So a team that reads `you/tool` and `your-org/app` creates two tokens, one
for each owner. teamrig finds each by its name, `teamrig-gh-<owner>`, so no config names them.

### Create a token

Do this once per owner:

1. On GitHub: **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Token name**: `teamrig-<what>` with dashes, e.g. `teamrig-issues`. **Expiration**: 90 days is a fair balance.
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
ACCESS globex: read with the token saved as teamrig-gh-globex
REPO globex/site: 1 to add, 0 to change, 0 unchanged
ADD new gh:globex/site#4 p2 web: "Broken footer link"
PREVIEW nothing was written; teamrig issue sync --yes writes the above as github
```

A repository that cannot be read gets a `FAILED` line saying what to fix; its tasks stay as they are and the other
repositories are read on. A `LEFT OUT` line names, by number only, the open issues by people outside the repository
that no one accepted yet (at most 20, then how many more); their text is never printed. `teamrig issue sync --repo
acme/web` reads one repository only.

## Then it runs on its own

Once the repositories are listed, nobody needs to run it. When a session of the team starts or ends a turn, its hook
makes sure the team's one `teamrig issue watch` runs, starting it hidden in the background when none does. Every
`probeSeconds` (60) the watch asks GitHub whether each repository's issues, pull requests or Actions runs changed. It
sends the answer it got last time, so GitHub answers "not modified" when nothing changed, and that answer does not
count against the rate limit. Only when something changed does it run `teamrig issue sync --auto`, so a new issue
reaches its owner within about a minute while an idle repository costs nothing.

- After a sync that failed, the next waits 15 minutes; a repository the watch cannot ask is synced every 15 minutes, so
  its failure still reaches the lead.
- The watch stops 10 minutes after the team's last session closed; the next session to start brings it back.
- It also stops after 24 hours, and the next hook starts a fresh one, so it never runs old code for long.
- One runs per team: it holds `state/github-watch.json` with its process id and kit version, and a second one
  started by mistake stops at once. After an update, the first hook of the new kit takes the lease over and starts
  the new code; the old watch stops at its next round.

- Each session with new tasks gets one inbox line, for example
  `github: GitHub sync added 1 task(s) for you: T42 gh:acme/web#7 "Fix the login redirect"`.
- `teamrig list` shows such a task with its issue: `T42 open, p1, owner web, from gh:acme/web#7 | Fix the login redirect`.
- A repository that cannot be read is told to the lead's inbox once, with the `FAILED` reason, and again when every
  repository reads again; it is not repeated at every run.
- An outsider's issue left out for the first time is told to the lead's inbox once, by ref only, for example
  `github: GitHub sync left out 1 new open issue(s) by people outside the repository: gh:acme/web#12; add the
  "teamrig" label to one on GitHub to make it a task at the next sync`.

### Pull request news

Each run also reads every open pull request of each repository, and those changed since the last automatic run, and
compares them with what that run kept. The news is a pull request opened, merged or closed unmerged, or one that
starts to conflict with its base, to fail its checks, or gets approved or changes requested, and, with
`github.activity` on (the default), one whose checks pass after failing or running. Each is told once, never again
while it lasts; the first run on a repository only notes what is there.

- It goes to the owner of the task the pull request's branch names (`t42-login` names T42) when one of the team's
  own authors pushed that branch to the repository itself: the repository's owner, or a login in `owners`. A
  collaborator or member the team never listed counts as an outsider, since write access lets anyone push a
  `t<id>-` branch. A fork's or an outsider's pull request, or a branch that names no task, goes to
  `github.watcher` in the team config; unset, the session holding a service role with `issue comment`, the one that
  answers on GitHub; else the lead.
- With `github.activity` on, the same news also goes to the owner of the task holding the pull request or an issue
  of the same repository it closes (a `Fixes #12` link GitHub knows), whatever its branch or author, and to each
  session following it (`teamrig follow`). Such a copy never wakes.
- Each session gets one inbox line, for example
  `github: GitHub pull requests: gh:acme/web#20 "Fix the login redirect": conflicts with its base`. A conflict,
  failing checks or changes requested on the session's own pull request (a `t<id>-` branch of one of the team's
  authors, not a fork) also wake the session (when `wake.enabled`); a merge, a close, an approval, green checks, an
  outsider's conflict, red checks or changes requested, and an outsider's new pull request, which is the watcher's
  intake work, wait for its next turn.
- When the checks of a session's own pull request start failing, the run reads the end of each failed job's log
  (`gh run view --job <id> --log-failed`, at most 5 jobs a run) and writes it to
  `~/.teamrig/teams/<team>/state/github-ci/<owner>-<name>-<number>.md`, one file per pull request, the newest
  failure replacing the last: per job its name, its failed step and the last 20 lines, secrets redacted, fenced as
  data. The inbox line names each job, its step and that file, for example
  `checks failing ("test" at "Run tests"; log end in .../acme-web-20.md)`. An outsider's or a fork's red checks get no
  log read. Reading the logs needs **Actions: Read-only** on the token; without it the file says why.
- A run by hand prints the news as `PULL NEWS <session>` lines and keeps nothing, so the automatic run still tells it.
- A repository whose pull requests cannot be read gets a `FAILED <repo> pull requests:` line; its issues still sync,
  and what was last read of its pull requests is kept, so nothing is missed once it reads again.

### Mentions of your users

Each automatic run also reads the comments, review comments, reviews and issue or pull request bodies of each
repository written or edited since the last automatic run, and looks for an `@` naming one of your users: a login in
`github.owners`. A mention counts only where GitHub itself would notify for it, so not inside code or a `>` quote.

- The first automatic run that reads a repository starts its scan there: nothing written before it is told.
- Each new mention goes to one session: the owner of the task holding the issue (or, for a pull request, of the task
  a team author's `t<id>-` branch names, else of the task holding an issue it closes), else the session `github.areaOwners` gives one of its labels, else
  the session `github.owners` maps the mentioned login to, else the watcher (above). The inbox line
  names the item, the logins, the author and the link, with up to 300 characters of the text around the mention,
  quoted as data: `github: GitHub gh:acme/web#9 mentions @octocat: visitor wrote at https://github.com/acme/web/issues/9#issuecomment-2, it says "could you look?"`.
  Text that looks like it holds a secret is left out, with only the link.
- A mention wakes its session (when `wake.enabled`), but at most once per issue or pull request every 30 minutes; the
  rest arrive unwoken.
- A post by one of your users never routes, and neither does an edit that keeps a mention it already routed: an edit
  that adds a login routes only that login.
- One run reads at most 10 pages of 100 posts per list and the reviews of 20 pull requests. A busier repository is
  read up to that point; the watcher gets a `GitHub mentions of <repo> cut off` line, and the next run goes on from
  there.
- A repository whose posts cannot be read gets a `FAILED <repo> mentions:` line and is told to the lead like any
  failing repository; its scan goes on from where it was once it reads again.
- A run by hand reads no posts.

### Activity on your tasks

With `github.activity` on (the default), each automatic run also tells the owner of the task holding an issue or pull
request what else happened on it since the last run. It uses what the run already read, so it costs no GitHub call.

- Each new comment, review comment and review goes to the task's owner, in one inbox line per session per run, for
  example `github: GitHub activity: gh:acme/web#9 comment by visitor at https://github.com/acme/web/issues/9#issuecomment-4`.
  A post that asks a question (a `?` outside code and quotes) wakes the owner (when `wake.enabled`), at most once per
  item every 30 minutes; the rest wait for its next turn. A post already told as a mention is not told again, and a
  post by one of your users (a login in `github.owners`) is not told at all.
- A close, a reopen, and each label put on or taken off an issue a task holds go to its owner in one line that never
  wakes, for example `github: GitHub issue changes: gh:acme/web#9 closed, labelled "help wanted"`. Not told: a close
  while the task is already done or dropped (the team closed it) and a reopen while it is still open, teamrig's own
  `status:` and `design` labels, and a label one of your users put on last. The first run that sees an issue only notes
  it, so turning the feature on tells nothing of the past.
- The pull request news of a task's pull request, or of one closing its issue, reaches the owner too
  ([Pull request news](#pull-request-news)).
- A session can follow any issue or pull request of `github.repos`: `teamrig follow acme/web#9` (at most
  `github.followMax`, 20 by default), `teamrig follow --list`, `teamrig unfollow acme/web#9`. It then hears all of the
  above for that item, never woken.
- With `github.activity` off, none of these lines go; mentions, and pull request news to the branch's owner or the
  watcher, still do.

### Security issues

An open issue labelled `security` (any case, set by the issue form or by a maintainer) goes to its task's owner,
else where the import would route it, an outsider's left-out report too. The automatic run wakes that session with a
line naming only the issue's ref and URL, never its title, which may describe the hole, and pages the owner through
the page webhook the team's `alerts` name (`teamrig page test` checks it). Each issue pages once ever: the sync
state keeps every number paged for good, so a label set after the issue was imported pages too, and one that stays
open, is closed and reopened, or loses the label and gets it again never pages again. A run pages and wakes for at
most 3 such issues; anyone can open issues with the form, so the rest of a burst go to the lead in one line and one
page that count them and name their refs (ten at most), and their sessions are not told. When no page goes, the lead
is woken with why.

## Answer times

Each sync that writes (`--yes` or the automatic one) also times how long each open issue and pull request has waited
for an answer of yours, so nobody outside waits unseen. A thread waits from the first post by someone outside the
team after your last reply, so a "any news?" follow-up does not restart the wait. A post counts as yours when its
author is a login of `github.owners` or the account that owns the repository; an outside contributor given
collaborator access still waits on you. A team whose `github.owners` names no one counts every member's, owner's and
collaborator's post as its own. A bot's post counts as nobody's. On a pull request a review counts as a post, once
submitted; a draft waits on nobody until it is marked ready for review. The target depends on the thread:

| Thread | Answer within |
| --- | --- |
| labelled `security` | 4 h |
| labelled `bug` | 24 h |
| a pull request | 24 h |
| on an issue one of your tasks tracks | 24 h |
| any other: a feature ask or a question | 72 h |

- At 75% of the target, the session that answers it (the owner of the task tracking it, else the one its import
  would go to; for a pull request, the one its pull request news goes to: the owner of the task its branch names,
  else the watcher) gets one inbox line, without a wake, for example `github: GitHub gh:acme/web#9 (bug) has waited 18 h for
  an answer of ours, since 11-15 08:00 UTC; answer it in words on GitHub by 11-16 08:00 UTC, its 24 h target, or
  GH-LATE goes to the lead`.
- At 100%, `teamrig check` shows the lead `GH-LATE gh:acme/web#9 (bug, web) has waited 25 h ...`, once per wait.
- Your answer, or the issue or pull request closing, stops the clock. A repository that cannot be read keeps its clocks until it can.
- `teamrig stats` shows the W your GitHub-linked tasks used on its `GITHUB` line. That number stays in teamrig:
  nothing is posted to GitHub.

The clocks live in `state/github-clocks.json` in the team's folder. Reading them costs no GitHub call: `check` reads
what the last sync kept.

`"probeSeconds": 0` turns the automatic sync off, and stops a running watch at its next round. `TEAMRIG_GITHUB=off`
turns every sync off on one machine, but only for a watch started after it is set: a running watch keeps the
environment it started with, so set `probeSeconds` to 0 to stop it.
`teamrig issue sync --yes` still works at any time.

## Moving your tasks to issues

To move a team's task list to GitHub, say before a repository goes public, `teamrig issue migrate` opens one issue per
task you choose. Issues are public on a public repository, so you write each one's wording yourself, in a row file
of JSON lines. The [write-issue skill](../plugins/teamrig/skills/write-issue/SKILL.md) has the steps for a body a
contributor can take alone: what binds the work, the sections, sub-issues for a goal, labels, and the read-back.

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
labels (where the repository lacks it, it makes first, with a `MADE` line, the `design` label or a label the
repository's `.github/labels.json` defines, with that file's colour and description; any other label must already
be there), and `teamrig issue close` closes one, first posting its `--comment` when given; a pull request closes
unmerged. `--reason completed`, `not-planned` or `duplicate` says why it closed (GitHub keeps it on an issue only);
`--duplicate-of` closes it as a duplicate of another issue of the same repository, which GitHub links as the
original. `teamrig issue edit` replaces the body (the description) with the text of a file, so a spec of many lines
keeps its shape; the title, state and labels stay, and GitHub keeps the old body in the edit history. Each names its
target as `owner/name#number`.

Each text teamrig posts (a comment, a close comment, a claim reply, a migrated issue, a replaced body) ends with a
one-line footer, `Made with teamrig <version>` linking to the project, then a hidden `<!-- teamrig-stamp -->` marker.
The marker is how a later write finds the footer: posting a stamped text again, or editing a body read back with its
footer, keeps one footer at the current version. A text the footer would push past the 65,536 characters GitHub holds
is posted without it. A team that wants no footer sets `github.stamp` to false.

```sh
teamrig issue comment acme/web#7 --body "Fixed in #9, thank you."
teamrig issue label acme/web#7 --add "type: bug,p1" --remove "needs triage"
teamrig issue edit acme/web#7 --body-file spec.md
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
  and nothing is posted; the same holds for the file `teamrig issue edit` reads.
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
LABEL acme/web#7 T41 in-progress: add status:in progress, take off status:open
CLOSE acme/web#9 T42 done: close as completed, take off status:in review
LABEL acme/web#11 T43 open: add status:claimed, take off status:open, assign acme
KEPT acme/web#5 T30 open: closed on the host (not_planned) while the task is active; the push never reopens an issue, so set the task to match or reopen the issue
PREVIEW nothing was written; a push would send 7 write(s) now, at most 40 a run, and plan the rest again on the next
```

- **One status label.** An `open` task no one scheduled shows `status:open`: open to anyone, no one assigned. Once
  it has a due date, or a person assigned the issue, it shows `status:claimed`. `in-progress` shows
  `status:in progress`, `waiting` `status:waiting`, `verifying` `status:in review`; any other `status:` label comes
  off. A goal, a task planned after its parts, shows none: its parts' issues carry theirs. Done closes the issue as
  completed, dropped as not planned. A repository that lacks one of these labels gets it made first, with a
  `MADE` line: these five and `design` are the only labels teamrig ever makes, and the push makes its five only with
  `--yes` or the automatic push.
- **A design issue shows none.** An issue labelled `design` is talk about how something should work, not work to
  take until it is agreed: the push takes every `status:` label off it and assigns it to no one, whatever its task's
  status. Its task ending never closes it: an `OPEN` line names it, and the maintainers' `Agreed:` ends it.
- **Planned against GitHub as it is.** The plan compares each task with its issue as listed now, so a label someone
  changed by hand is set back, and a run that stopped half way is planned again whole.
- **A person's close stands.** An issue closed while its task is active is never reopened: a `KEPT` line names it.
- **One team task speaks for an issue.** When a team task and an imported one hold the same issue, the team task
  speaks for it. When two or more active team tasks (open, in progress, waiting, verifying) hold it, none does: the
  push writes nothing to it and a `SHARED` line names them, so a person gives the ref to one of them. A finished task
  often keeps its ref, so one active team task speaks over finished ones; with none active, the newest finished one
  speaks.
- **A taker's issue stays theirs.** A done or dropped task closes its issue only when the issue is unassigned or
  assigned to the team: the logins `github.owners` maps and the account that owns the repository. An issue assigned
  only to people outside the team is their work, and a task that only took part in it (a comment, an answer) ends
  without closing it: an `OPEN` line names it, for its taker's pull request or a person to close. A session's second
  login in `github.owners` reads as outside the team here; map each session to the one login it assigns by.
- **Someone answers for it.** An open issue of a scheduled task (started, or with a due date), not a design issue,
  no one is assigned to gets an assignee: the login `github.owners` maps to the task's owning session, else the account that owns the
  repository (sessions are not GitHub users). An issue a person assigned keeps its assignees; the push takes none off. Each login is read first: one the repository may
  not assign (not a person with access to it) gets an `UNASSIGNED` line and its issues keep their label changes, as
  GitHub would drop it silently and every run would send it again.
- **Fields and type too.** On a repository with issue fields or types, the push then sets each held open issue's
  fields, one way from the task list: the priority as an option of a single-select `Priority` field (`P<n>`, else
  GitHub's own: p0 and p1 Urgent, p2 High, p3 Medium, p4 and p5 Low; `priorityOptions` renames them), the
  day the task first went in progress to the date field `Start date`, its due day to `Target date` and its score,
  rounded, to the number field `Score`; and its type: a task `Task`, a bug `Bug`, a goal `Feature` (else `Goal`), a
  design issue `Design`. Each is a `FIELD` or `TYPE` line, sent only where it differs, in the same writes per run as
  the labels. A field the repository lacks, or of another kind, is skipped with one `NOTE`; a repository with no
  fields or types prints nothing. A value set by hand is set back, nothing is cleared, and the labels stay. The
  names, the type each kind is set as, and turning it off are the `fields` block under `github` in the team config.
- **Within GitHub's limit.** At most 40 writes a run, half GitHub's 80 a minute, shared by every repository in
  `github.repos` order; the rest waits for the next run.
- **On its own, once you turn it on.** With `"statusPush": true` in the team config's `github` block, the
  [automatic sync](#then-it-runs-on-its-own) sends the push after each import, so no session runs it. Each run then
  sends fewer writes when the sync can run often, so an hour of runs sends at most 250, half GitHub's 500 an hour
  (probing every 60 seconds: 4 a run; every 300: 20). Its own label writes read as a change, so a longer list drains
  a run per probe. It sends labels, assignees, fields and types only: a close is the one write a person reads as a decision,
  so the automatic push prints it as a `HELD` line and leaves it to a session's `teamrig issue sync --push --yes`.
  A failed write is told to the lead's inbox like a repository that cannot be read. It is off by default: read `teamrig issue sync --push` first, and give the token **Issues: Read and write**.

### Claims: a contributor takes an issue by a comment

With the push on, the automatic sync also lets a contributor take an open issue themselves. A comment whose line
starts with `/take`, "I'll take", "I'm working on" or "I can take" (not quoted, not in a code block) claims an issue
that has no assignee, is neither a `design` nor a `security` issue, and is the repository's own or accepted (an
outsider's issue waits for the accept label first, as it does to become a task). The sync then assigns the
commenter, swaps `status:open` for `status:claimed`, and replies once with the rule:

- **Seven days to link a pull request.** A claim with no pull request linked to the issue after seven days ends: the
  sync takes that assignee off, puts `status:open` back and says so on the issue. A linked pull request keeps the
  claim.
- **Only its own claims.** The sync takes off only an assignee it made by a claim, kept in
  `state/github-claims.json`; an assignee a person set is never taken off, and a claim handed to someone else or
  closed is forgotten.
- **People, outside the repository, one at a time.** Apps, organizations and the repository's own members and
  collaborators do not claim by comment (a member assigns); one login holds one claim per repository.
- **Five a day.** At most five claims a day per repository, so throwaway accounts cannot tie up every issue; past
  that a claim waits for a person to assign it.
- **Only new comments.** Each run reads only the comments posted since the previous run started, so a comment
  from before the push was turned on claims nothing.
- **Ten issues a run.** The issue list carries no comment text, so a run reads the new comments (the first 30) of
  at most ten issues whose new comments could claim, oldest first; the rest are printed `HELD` and read on the next
  run, as is an issue whose read failed. A claim past an issue's first 30 new comments waits for a person to assign.
- **Within the run's writes.** A claim's writes (assign, labels, reply) count in the same writes per run as the
  status push, and come first; a claim past them is printed `HELD` and made on the next run. A run whose share of
  the hour is less than one claim's 5 writes (4 at the default `probeSeconds` of 60) may still send one whole claim:
  at most five claims a day per repository keep that small.

## Linking issues as the task tree

`teamrig issue links` puts the task tree on the issues of `github.repos`. A task planned after another (`--after`),
or waiting on it (`--waits task:T10`), both mirrored in one repository, makes its issue blocked by the other's on
GitHub. A whole is planned after its parts, so a part planned before exactly one whole becomes that whole's sub-issue
as well. Without `--yes` it reads the links GitHub has and shows what it would add:

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
| `no token for acme is saved as teamrig-gh-acme` | No token is saved for that owner. teamrig never reads or writes through the `gh` login in its place. | Save a token for the owner (step 2). |
| `gh, the GitHub CLI, is not installed` | `gh` is missing. | Install it from [cli.github.com](https://cli.github.com). |
| `could not read teamrig-gh-acme from ...` | The token is saved, but the credential store could not be read (a locked keyring, for one). Nothing ran for that owner: teamrig never uses the `gh` login in a saved token's place. | Unlock the store and rerun, or save the token again. |

## Safety

- **Read-only sync.** The sync runs only the issue queries and the pull request queries teamrig ships, word for word,
  through `gh api graphql`, the read of one failed CI job's log
  (`gh run view --job <id> --log-failed --repo <owner>/<name>`, exactly those arguments), and the mention scan's
  GET pages (`repos/<owner>/<name>/issues/comments`, `.../pulls/comments` and `.../issues`, each with only its
  `since`, sort, `per_page=100` and page, and `.../pulls/<number>/reviews?per_page=100`), so a token with
  **Issues: Read-only**, **Pull requests: Read-only** and **Actions: Read-only** is all it needs. Of an issue's newest
  20 comments it reads only when each was posted, its author's login, tie to the repository and whether that author is
  a bot: never their text. Only with the push on, a claim reads the text of an issue's comments posted since the last
  run (`.../issues/<number>/comments -X GET` with `since` and `per_page=30` only, one page), for at most ten issues a
  run, to find a claim line, and keeps no text. The mention scan reads post text to find mentions of your users and
  keeps only each post's key, the logins it routed and its time ([Mentions of your users](#mentions-of-your-users)).
  The push also reads each open issue's type and field values, with the repository's fields and types, never its text.
  Any other `gh` command or query is refused in code, except
  the writes, each run by hand on a repository in `github.repos`: `teamrig issue migrate`'s create of one issue
  (`gh api repos/<owner>/<name>/issues -X POST` with its title, body and labels only), `teamrig issue comment`'s
  one comment (`.../issues/<number>/comments -X POST` with its body only), `teamrig issue label`'s read of one label
  (`repos/<owner>/<name>/labels/<label>`), add (`.../issues/<number>/labels -X POST` with its labels only) and take
  off (`.../issues/<number>/labels/<label> -X DELETE`), `teamrig issue close`'s close
  (`.../issues/<number> -X PATCH` with `state=closed` and its `state_reason` only, a duplicate's also with the
  original's `duplicate_issue_id`, digits only) and the read of that original (`.../issues/<number> -X GET`, no
  field), the status push's read of whether one login may be assigned (`repos/<owner>/<name>/assignees/<login>`)
  and its assign (`.../issues/<number>/assignees -X POST` with logins only, never a removal), its field and type
  writes (`.../issues/<number>/issue-field-values -X POST` with one field id and one value, `.../issues/<number>
  -X PATCH` with `type` only), the read of the repository's label file
  (`repos/<owner>/<name>/contents/.github/labels.json` with the raw media type, nothing else), the create of a label
  teamrig makes (`repos/<owner>/<name>/labels -X POST` with the name, colour and description of one of the five
  status labels or `design`, word for word) or of one that file named when the same run read it, word for word, and
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
