---
name: security
description: Use before installing or upgrading a package, editing overrides or a lockfile, adding a third-party web origin, writing a container or pod spec, or handling a secret.
---

# Security steps

The core rules hold what applies on any turn (never print a secret value; bind local services to 127.0.0.1, never
0.0.0.0). This skill holds the steps for the moments below. The
[package guard](../teamrig-guide/hooks.md#before-a-shell-command-the-package-guard) refuses an ad-hoc package run and
the [secret guard](../teamrig-guide/hooks.md#before-a-shell-command-or-a-read-the-secret-guard) a call that prints a
secret file or variable, by themselves.

## Installing or upgrading a package

1. Find the exact version that will install, not the range: the newest one `npm view <pkg>@<range> version` lists, or
   the one the regenerated lockfile names (step 3 of the next section).
2. Check that version before it lands: its publish date (a release under two weeks old is unproven, not safe), its
   advisories (`npm audit`, the GitHub Security Advisories) and the project's own supply-chain gate when it has one.
   Provenance and attestations prove who built a package, not that it is clean: a hijacked maintainer account signs
   valid ones.
3. Never fetch and run a package ad hoc (`npx`, `npm exec`, `npm create`, `pnpm dlx`, `yarn dlx`). Add it as a pinned
   devDependency and run its local bin (`npx --no -- <bin>`).

## Pinning with overrides

1. Pin a package that has ever been a supply-chain target to its exact version through `overrides` (npm) or
   `pnpm.overrides`: a caret or tilde range lets a hijacked release in. A pin on the direct dependency is not enough:
   check whether a transitive package depends on it with a loose range (`"*"`, `">=6"`), which bypasses that pin.
2. Scope an override to the affected major (`"flat-cache@6": "6.1.13"`), never a bare `"pkg": "x.y.z"`: that forces
   every consumer onto the version and can drag an unrelated dependent across majors.
3. An edited `overrides` block re-resolves the whole graph. Regenerate the lockfile without installing or running
   scripts (`npm install --package-lock-only --ignore-scripts`, `pnpm install --lockfile-only --ignore-scripts`), read
   its diff and revert each unrelated version float, so a security pin never pulls in fresh releases of other packages.

## Secrets

- Mask a secret wherever a command would print it: a connection string without its password, counts rather than
  record bodies. The secret guard cannot see a script or program that prints one, so mask inside what you write.
- Never write a secret into a file the repository tracks or the team shares.
- A container gets each secret by its own key (Kubernetes `secretKeyRef`), never a whole secret through `envFrom`.

## Containers and pods

- No service-account token unless the pod calls the cluster's API (`automountServiceAccountToken: false`).
- Run with the `RuntimeDefault` seccomp profile and drop ALL capabilities.

## Web pages

- A new third-party origin (a script, API, font or image host) updates the page's Content-Security-Policy in the same
  change.
