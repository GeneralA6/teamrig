import { isRecord, recordField, stringField } from "../core/guards.js";
/** The public registry, which also holds the advisory database. */
export const NPM_REGISTRY = 'https://registry.npmjs.org/';
/** A package's path on the registry: a scope's slash is escaped (`@types%2Fnode`). */
function packagePath(name) {
    return encodeURIComponent(name).replace(/^%40/, '@');
}
function packageDocOf(raw, name) {
    if (!isRecord(raw)) {
        throw new Error(`the registry sent ${name}'s document as something other than an object`);
    }
    const distTags = new Map();
    for (const [tag, version] of Object.entries(recordField(raw, 'dist-tags') ?? {})) {
        if (typeof version === 'string') {
            distTags.set(tag, version);
        }
    }
    const published = new Map();
    for (const [version, time] of Object.entries(recordField(raw, 'time') ?? {})) {
        const at = typeof time === 'string' ? Date.parse(time) : Number.NaN;
        if (!Number.isNaN(at)) {
            published.set(version, at);
        }
    }
    return { distTags, published };
}
function advisoriesOf(raw) {
    if (!isRecord(raw)) {
        throw new Error("the registry's advisory service answered with something other than an object");
    }
    return Object.entries(raw).flatMap(([name, list]) => (Array.isArray(list) ? list : []).filter(isRecord).map((entry) => ({
        name,
        title: stringField(entry, 'title') ?? 'an untitled advisory',
        severity: stringField(entry, 'severity') ?? 'unknown',
        url: stringField(entry, 'url') ?? '',
    })));
}
/** The registry at `base` over HTTP: a package's full document (its publish times are not in the short one) and one bulk advisory request. */
export function httpPackageRegistry(base = NPM_REGISTRY) {
    const root = base.endsWith('/') ? base : `${base}/`;
    return {
        async packageDoc(name, signal) {
            const response = await fetch(`${root}${packagePath(name)}`, { signal, headers: { accept: 'application/json' } });
            if (response.status === 404) {
                return undefined;
            }
            if (!response.ok) {
                throw new Error(`the registry answered ${response.status} for ${name}`);
            }
            const raw = await response.json();
            return packageDocOf(raw, name);
        },
        async advisories(versions, signal) {
            const body = JSON.stringify(Object.fromEntries([...versions].map(([name, list]) => [name, [...list]])));
            const response = await fetch(`${root}-/npm/v1/security/advisories/bulk`, {
                method: 'POST',
                signal,
                headers: { accept: 'application/json', 'content-type': 'application/json' },
                body,
            });
            if (!response.ok) {
                throw new Error(`the registry's advisory service answered ${response.status}`);
            }
            const raw = await response.json();
            return advisoriesOf(raw);
        },
    };
}
