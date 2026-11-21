/**
 * The team config keys only the owner changes, by path: each is a permission or an owner gate (core rule 6). Who
 * holds a role or a service role; what is owner- or security-gated; who the owner is in the register; the asks, route
 * and read-only allow rules; the exec review; the alerts; whose GitHub logins count as ours; the guards; and each
 * repository's merge, deploy and check commands, which teamrig runs with the full environment; and the UI entry script
 * `teamrig ui` runs in the person's own terminal, outside every Claude Code guard. A key's entries and
 * fields are under it. One list for both readers (#1470): the config guard refuses a session's write of any of them
 * (service-role-guard.ts), and `teamrig config get` shows each as owner-gated (settings.ts), so it never shows a key
 * the guard refuses as editable.
 */
export const OWNER_GATED_KEYS: readonly (readonly string[])[] = [
  ['serviceRoles'],
  ['roles'],
  ['ownerGates'],
  ['securityGates'],
  ['register', 'ownerSource'],
  ['prompts'],
  ['readonlyShell'],
  ['exec'],
  ['alerts'],
  ['github', 'owners'],
  ['delivery', 'repos'],
  ['delivery', 'passEnv'],
  ['permissions'],
  ['pushGuard'],
  ['secretGuard'],
  ['packageGuard'],
  ['dbWriteGuard'],
  ['commitGuard'],
  ['ui'],
];
