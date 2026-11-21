import { INTERFACE_VERSION } from "./version.js";
/**
 * The one text a document's parts spell, which the command hashes into the revision. The interface version is part
 * of it, so a teamrig serving a newer minor never answers `unchanged` to a revision an older one handed out: the
 * same stores may now hold a field more. JSON keeps the parts apart, so no value can be read as two.
 */
export function revisionText(parts) {
    return JSON.stringify([INTERFACE_VERSION, parts.document, parts.args, parts.stamps]);
}
