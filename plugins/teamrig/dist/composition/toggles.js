import { featuresOf } from "../plugin-api/index.js";
/**
 * A supported feature runs unless the team turns it off. One supported in part runs as the team asks, else as its
 * registry row says. An unsupported one never runs.
 */
function toggleOf(support, asked, byDefault) {
    switch (support.kind) {
        case 'supported':
            return asked ?? 'on';
        case 'partial':
            return asked ?? byDefault;
        case 'unsupported':
            return 'off';
    }
}
/**
 * The toggle of every feature of `side` on the adapter whose manifest this is. Asking `on` for a feature the
 * adapter does not support is refused with the manifest's notice, so a team never believes a guard runs that
 * cannot; so is an id that is no feature of the side.
 */
export function resolveToggles(side, manifest, asked) {
    const rows = featuresOf(side);
    const known = new Set(rows.map((row) => row.id));
    const strays = Object.keys(asked)
        .filter((id) => !known.has(id))
        .map((id) => `${id} is no ${side} feature`);
    const unsupported = rows.flatMap((row) => {
        const support = manifest[row.id];
        return support.kind === 'unsupported' && asked[row.id] === 'on' ? [`${row.id} cannot be on: ${support.notice}`] : [];
    });
    const notices = [...strays, ...unsupported];
    if (notices.length > 0) {
        return { kind: 'refused', notices };
    }
    return { kind: 'resolved', toggles: new Map(rows.map((row) => [row.id, toggleOf(manifest[row.id], asked[row.id], row.byDefault)])) };
}
