import assert from 'node:assert/strict';
import { isStringArray } from "../../plugin-api/index.js";
import { defineContract } from "../contract.js";
const PLATFORMS = ['linux', 'darwin', 'win32'];
/** Two rule sets no liar's fixed answer equals. */
const FIRST = { allow: ['Bash(ls)', 'Read(/work/**)'], deny: ['Read(~/.npmrc)'] };
const SECOND = { allow: ['Bash(git status)'], deny: ['Read(//**/.env)', 'Bash(env)'] };
const TAG = '[kit team] ';
const LINES = [`${TAG}pushes go to the team's own remote`, `${TAG}deploys run through the team's queue`];
/** A route the person wrote by hand, and one of another team: both stay as they are. */
const HAND = 'Source control: git.example/acme';
const OTHER_TEAM = '[kit other] its own route';
function valueOf(answer, what) {
    assert.ok(answer.ok, answer.ok ? '' : `${what} was refused: ${answer.problem}`);
    return answer.value;
}
/** The plan of a route change that must go through, with the settings it leaves: the plan's own, else the ones it was given. */
function planned(answer, settings, what) {
    const plan = valueOf(answer, what);
    return { plan, left: plan.settings ?? settings };
}
function tagged(routes) {
    return (routes ?? []).filter((line) => line.startsWith(TAG));
}
function rulesOf(reading) {
    return { allow: reading.allow.ok ? reading.allow.value : undefined, deny: reading.deny };
}
const CASES = [
    {
        id: 'permissions.reads-rules',
        title: 'reads the allow and deny rules the settings hold, and none from settings without them',
        features: ['permissions.deny-lines'],
        run: ({ port, world }) => {
            for (const rules of [FIRST, SECOND]) {
                assert.deepEqual(rulesOf(port.read(world.settings(rules))), { allow: rules.allow, deny: rules.deny });
            }
            assert.deepEqual(rulesOf(port.read(world.settings({}))), { allow: [], deny: [] });
        },
    },
    {
        id: 'permissions.names-bypass',
        title: 'names the setting that lets every tool call run without asking, and only when the settings hold it',
        features: ['permissions.deny-lines'],
        run: ({ port, world }) => {
            const bypass = port.read(world.settings({ ...FIRST, bypass: true })).bypass;
            assert.ok(bypass !== undefined && bypass.trim() !== '', `the bypass reads ${JSON.stringify(bypass)}`);
            assert.equal(port.read(world.settings(FIRST)).bypass, undefined);
        },
    },
    {
        id: 'permissions.writes-allow',
        title: 'puts a new allow list in place and keeps the deny rules as they were',
        features: ['permissions.deny-lines'],
        run: ({ port, world }) => {
            assert.notEqual(port.allowSetting.trim(), '', 'the allow setting has no name');
            assert.notEqual(port.denySetting.trim(), '', 'the deny setting has no name');
            const written = valueOf(port.writeAllow(world.settings(FIRST), SECOND.allow), 'the allow write');
            assert.deepEqual(world.allowOf(written), SECOND.allow);
            assert.deepEqual(rulesOf(port.read(written)), { allow: SECOND.allow, deny: FIRST.deny });
        },
    },
    {
        id: 'permissions.deny-lines-read-back',
        title: "gives each platform's credential deny lines once each, and reads them back from settings that hold them",
        features: ['permissions.deny-lines'],
        run: ({ port, world }) => {
            for (const platform of PLATFORMS) {
                const lines = port.denyLines(platform);
                assert.ok(lines.length > 0, `${platform} has no deny line`);
                assert.equal(new Set(lines).size, lines.length, `${platform} names a line twice`);
                assert.deepEqual(port.read(world.settings({ deny: lines })).deny, lines, platform);
            }
        },
    },
    {
        id: 'permissions.installs-routes',
        title: "puts the team's routes in where there were none, and a second install changes nothing",
        features: ['permissions.auto-mode-routes'],
        run: ({ port, world }) => {
            assert.notEqual(port.routesSetting.trim(), '', 'the routes setting has no name');
            const first = planned(port.installRoutes(world.routes(), TAG, LINES), world.routes(), 'the install');
            assert.deepEqual(tagged(world.routesOf(first.left)), LINES);
            assert.deepEqual(tagged(first.plan.added), LINES);
            assert.equal(planned(port.installRoutes(first.left, TAG, LINES), first.left, 'the second install').plan.settings, undefined, 'a second install plans a change');
        },
    },
    {
        id: 'permissions.keeps-other-routes',
        title: "leaves a hand route and another team's routes in through an install and an uninstall",
        features: ['permissions.auto-mode-routes'],
        run: ({ port, world }) => {
            const before = world.routes([HAND, OTHER_TEAM]);
            const installed = planned(port.installRoutes(before, TAG, LINES), before, 'the install');
            assert.deepEqual(world.routesOf(installed.left), [HAND, OTHER_TEAM, ...LINES]);
            const removed = planned(port.uninstallRoutes(installed.left, TAG), installed.left, 'the uninstall');
            assert.deepEqual(world.routesOf(removed.left), [HAND, OTHER_TEAM]);
            assert.deepEqual(removed.plan.removed, LINES);
        },
    },
    {
        id: 'permissions.uninstall-leaves-none',
        title: "takes the team's routes out again, and leaves settings that never held them alone",
        features: ['permissions.auto-mode-routes'],
        run: ({ port, world }) => {
            const installed = planned(port.installRoutes(world.routes(), TAG, LINES), world.routes(), 'the install');
            assert.deepEqual(tagged(world.routesOf(installed.left)), LINES, 'the install left no route');
            assert.deepEqual(tagged(world.routesOf(planned(port.uninstallRoutes(installed.left, TAG), installed.left, 'the uninstall').left)), []);
            for (const untouched of [world.routes(), world.routes([HAND])]) {
                assert.equal(planned(port.uninstallRoutes(untouched, TAG), untouched, 'the uninstall').plan.settings, undefined, 'an uninstall changed settings the routes were never in');
            }
        },
    },
];
function listOf(settings, key) {
    const list = settings[key];
    return isStringArray(list) ? list : undefined;
}
/** The liars' world: each list one field of the settings, the bypass a flag. */
const WORLD = {
    settings: ({ allow, deny, bypass }) => ({
        ...(allow === undefined ? {} : { allow: [...allow] }),
        ...(deny === undefined ? {} : { deny: [...deny] }),
        ...(bypass === true ? { bypass: true } : {}),
    }),
    allowOf: (settings) => listOf(settings, 'allow'),
    routes: (lines) => (lines === undefined ? {} : { routes: [...lines] }),
    routesOf: (settings) => listOf(settings, 'routes'),
};
const NAMES = { allowSetting: 'allow', denySetting: 'deny', routesSetting: 'routes' };
/** A liar that claims the port and does nothing: no rule is read, no deny line named, and no change goes in. */
export function nothingPermissions() {
    const unchanged = () => ({ ok: true, value: { settings: undefined, removed: [], added: [] } });
    return {
        world: WORLD,
        port: {
            ...NAMES,
            read: () => ({ allow: { ok: true, value: [] }, deny: [], bypass: undefined }),
            denyLines: () => [],
            writeAllow: (settings) => ({ ok: true, value: settings }),
            installRoutes: unchanged,
            uninstallRoutes: unchanged,
        },
    };
}
/** A liar that says yes to all: every settings hold one fixed rule and a bypass, and every change goes through by writing empty settings. */
export function yesPermissions() {
    const emptied = () => ({ ok: true, value: { settings: {}, removed: [], added: [] } });
    return {
        world: WORLD,
        port: {
            ...NAMES,
            read: () => ({ allow: { ok: true, value: ['rule'] }, deny: ['rule'], bypass: 'bypass' }),
            denyLines: () => ['rule'],
            writeAllow: () => ({ ok: true, value: {} }),
            installRoutes: emptied,
            uninstallRoutes: emptied,
        },
    };
}
/** What every host's permissions port must do with the rules and trusted routes its settings hold. */
export const PERMISSIONS_CONTRACT = defineContract({
    port: 'permissions',
    side: 'host',
    cases: CASES,
    liars: [nothingPermissions, yesPermissions],
});
