/**
 * The privileged calls a skill's scripts make, which auto mode never sees: it judges the `node <script>` line, not
 * what the script runs (T746: a skill's script ran kubectl exec with a key read from the pod env for 13 runs, while
 * the same call written inline was refused). A skill names each kind its scripts make on a body line
 * `Grants: pod-exec, secret-read`, so whoever runs or reviews it sees the owner grants it relies on; the skills lint
 * flags a kind a script makes that no such line names.
 */
export const GRANT_KINDS = ['pod-exec', 'secret-read', 'auth-header'];
/** The files a skill's folder holds that the lint reads as scripts. */
export const SCRIPT_FILE = /\.(?:[cm]?[jt]s|sh|ps1|py)$/;
const GRANTS_LINE = /^Grants:[ \t]*(.*)$/gm;
/** A name segment that marks an environment variable as holding a credential (`API_KEY`, `DATABASE_URI_LOCAL`). */
const SECRET_SEGMENTS = new Set(['KEY', 'KEYS', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'PASS', 'CREDENTIAL', 'CREDENTIALS', 'URI']);
/** Environment reads by name: `$NAME`, `${NAME}`, `$env:NAME`, `process.env.NAME`, `process.env['NAME']`, `os.environ['NAME']`. */
const ENV_READS = [
    /\$(?:env:)?\{?([A-Z][A-Z0-9_]*)/g,
    /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /\b(?:process\.env|os\.environ)\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
    /\bos\.(?:environ\.get|getenv)\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
];
function readsSecretEnv(text) {
    return ENV_READS.some((pattern) => Array.from(text.matchAll(pattern), (match) => match[1] ?? '').some((name) => name.toUpperCase().split('_').some((segment) => SECRET_SEGMENTS.has(segment))));
}
/** kubectl's subcommand written inline (`kubectl -n x exec`) or as an argv item (`'kubectl', ['exec', ...]`). */
function runsKubectl(text, subcommand) {
    return /\bkubectl\b/.test(text) && subcommand.test(text);
}
const DETECTORS = [
    { kind: 'pod-exec', makes: (text) => runsKubectl(text, /\bkubectl\b[^\n]*?\sexec\b|['"`]exec['"`]/) },
    {
        kind: 'secret-read',
        makes: (text) => runsKubectl(text, /\bget\s+secrets?\b|['"`]get['"`]\s*,\s*['"`]secrets?['"`]/) || readsSecretEnv(text),
    },
    { kind: 'auth-header', makes: (text) => /\bauthorization\s*['"`]?\s*:|\bBearer\s|\bx-[a-z0-9-]*(?:key|token|secret|auth)\s*['"`]?\s*:/i.test(text) },
];
/** The privileged kinds a script makes, in GRANT_KINDS order. */
export function grantsMadeBy(script) {
    return DETECTORS.filter((detector) => detector.makes(script.text)).map((detector) => detector.kind);
}
function isGrantKind(word) {
    return GRANT_KINDS.some((kind) => kind === word);
}
/** The kinds a skill's `Grants:` lines name, and the words on them that name no kind. */
export function grantsOf(text) {
    const declared = new Set();
    const unknown = [];
    for (const match of text.matchAll(GRANTS_LINE)) {
        for (const word of (match[1] ?? '').split(/[\s,]+/).filter((each) => each !== '')) {
            if (isGrantKind(word)) {
                declared.add(word);
            }
            else {
                unknown.push(word);
            }
        }
    }
    return { declared, unknown };
}
/** One line per gap: each word on a `Grants:` line that is no kind, then each kind a script makes that none names. */
export function grantGaps(text, scripts) {
    const { declared, unknown } = grantsOf(text);
    const gaps = unknown.map((word) => `"Grants: ${word}" names no grant kind: use ${GRANT_KINDS.join(', ')}`);
    const missing = new Map();
    for (const script of scripts) {
        for (const kind of grantsMadeBy(script).filter((made) => !declared.has(made))) {
            missing.set(kind, [...(missing.get(kind) ?? []), script.name]);
        }
    }
    for (const kind of GRANT_KINDS.filter((each) => missing.has(each))) {
        const where = (missing.get(kind) ?? []).join(', ');
        gaps.push(`${kind} in ${where}, which auto mode does not see: with the owner's grant add "Grants: ${kind}", else drop the call`);
    }
    return gaps;
}
