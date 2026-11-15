/**
 * The roles after `roles grant` (T2984): the holder added to the role and the commands to its list, or a new role when
 * there is none by that name, which needs its commands. `team` replaces the named holders, and a session added to a
 * role every session holds is refused, as it changes nothing. Which commands `team` may hold is the config's own check
 * (TEAM_HELD_COMMANDS), run on the whole next file.
 */
export function granted(roles, name, holder, commands) {
    const current = roles[name];
    if (current === undefined && commands.length === 0) {
        return { ok: false, problem: `there is no role ${name}; name its commands with --commands to create it` };
    }
    const held = current?.holders ?? [];
    if (held === 'team' && holder.kind === 'session') {
        return { ok: false, problem: `every session of the team holds ${name} already` };
    }
    const holders = holder.kind === 'team' ? 'team' : held === 'team' || held.includes(holder.id) ? held : [...held, holder.id];
    const listed = current?.commands ?? [];
    const next = { holders, commands: [...listed, ...commands.filter((command) => !listed.includes(command))] };
    if (current !== undefined && sameRole(current, next)) {
        return { ok: false, problem: `${name} is held so already; nothing to change` };
    }
    return { ok: true, value: { ...roles, [name]: next } };
}
/**
 * The roles after `roles revoke`: the session taken off the role, or the whole role gone when no session is named or
 * the last holder leaves. A session cannot be taken off a role every session holds: revoke the role.
 */
export function revoked(roles, name, holder) {
    const current = roles[name];
    if (current === undefined) {
        return { ok: false, problem: `there is no role ${name}` };
    }
    const rest = Object.fromEntries(Object.entries(roles).filter(([key]) => key !== name));
    if (holder === undefined) {
        return { ok: true, value: rest };
    }
    if (current.holders === 'team') {
        return { ok: false, problem: `every session of the team holds ${name}; revoke the whole role, without --holder` };
    }
    if (!current.holders.includes(holder)) {
        return { ok: false, problem: `${holder} does not hold ${name}` };
    }
    const holders = current.holders.filter((id) => id !== holder);
    return { ok: true, value: holders.length === 0 ? rest : { ...roles, [name]: { ...current, holders } } };
}
/** One role in words: who holds it and what it runs, for the preview, the written line and `roles list`. */
export function describeRole(name, role) {
    if (role === undefined) {
        return `${name}: no role`;
    }
    const holders = role.holders === 'team' ? 'every session of the team' : role.holders.join(', ');
    return `${name}: held by ${holders}; runs ${role.commands.join(', ')}`;
}
function sameRole(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
