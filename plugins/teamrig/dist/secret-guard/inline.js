import { wordPath } from "./paths.js";
const JS = { family: 'js', code: ['-e', '--eval', '-p', '--print'], print: ['-p', '--print'], clusters: false, valued: '' };
const PYTHON = { family: 'python', code: ['-c'], print: [], clusters: false, valued: '' };
const INTERPRETERS = new Map([
    ['node', JS],
    ['bun', JS],
    ['tsx', JS],
    ['ts-node', JS],
    ['deno', JS],
    ['python', PYTHON],
    ['python3', PYTHON],
    ['python2', PYTHON],
    ['py', PYTHON],
    ['pythonw', PYTHON],
    ['ruby', { family: 'ruby', code: ['-e'], print: ['-p'], clusters: true, valued: 'rICxEFK' }],
    ['perl', { family: 'perl', code: ['-e', '-E'], print: ['-p'], clusters: true, valued: 'IMmxdCFD' }],
    ['php', { family: 'php', code: ['-r'], print: [], clusters: false, valued: '' }],
]);
/** A call that prints, per family: the match ends where its arguments start. */
const PRINT_CALLS = {
    js: /\b(?:console\s*\.\s*(?:log|info|warn|error|debug|dir|table|trace)|process\s*\.\s*std(?:out|err)\s*\.\s*write)\b/g,
    python: /\b(?:print|pprint|sys\s*\.\s*std(?:out|err)\s*\.\s*write)\b/g,
    ruby: /(?:\b(?:puts|print|pp|p|warn)|\$std(?:out|err)\s*\.\s*(?:puts|print|write))\b/g,
    perl: /\b(?:print|say|printf|warn|die)\b/g,
    php: /\b(?:echo|print|printf|print_r|var_dump|var_export)\b/g,
};
/** The whole environment, read as one value: `process.env`, `os.environ`, `ENV`, `%ENV`, `$_ENV`. */
const DUMPS = {
    js: /(?<!Object\s*\.\s*keys\s*\(\s*)\b(?:process|Bun)\s*\.\s*env\b(?!\s*(?:\??\.|\[))|\bDeno\s*\.\s*env\s*\.\s*toObject\b/,
    python: /\benviron\b(?!\s*(?:\[|\.\s*(?:get|keys|setdefault|pop)\b))/,
    ruby: /\bENV\b(?!\s*(?:\[|\.\s*(?:fetch|keys|key\?|include\?|has_key\?)))/,
    perl: /(?<!\bkeys\s*\(?\s*)%ENV\b/,
    php: /\$_(?:ENV|SERVER)\b(?!\s*\[)|\bgetenv\s*\(\s*\)/,
};
/** One variable, read by name: `process.env.TOKEN`, `os.environ['TOKEN']`, `ENV.fetch('TOKEN')`, `$ENV{TOKEN}`. */
const READS = {
    js: [
        /\b(?:process|Bun)\s*\.\s*env\s*\??\.\s*(?<name>[A-Za-z_]\w*)/g,
        /\b(?:process|Bun)\s*\.\s*env\s*(?:\?\.)?\s*\[\s*(['"`])(?<name>\w+)\1\s*\]/g,
        /\bDeno\s*\.\s*env\s*\.\s*get\s*\(\s*(['"`])(?<name>\w+)\1/g,
    ],
    python: [/\benviron\s*\[\s*(['"])(?<name>\w+)\1/g, /\benviron\s*\.\s*get\s*\(\s*(['"])(?<name>\w+)\1/g, /\bgetenv\s*\(\s*(['"])(?<name>\w+)\1/g],
    ruby: [/\bENV\s*\[\s*(['"])(?<name>\w+)\1/g, /\bENV\s*\.\s*fetch\s*\(\s*(['"])(?<name>\w+)\1/g],
    perl: [/\$ENV\s*\{\s*(['"]?)(?<name>\w+)\1\s*\}/g],
    php: [/\$_(?:ENV|SERVER)\s*\[\s*(['"])(?<name>\w+)\1/g, /\bgetenv\s*\(\s*(['"])(?<name>\w+)\1/g],
};
/** Code that builds a path from the home folder, so a bare `.npmrc` in it may name `~/.npmrc`. */
const HOME_HINT = /homedir|expanduser|\bHOME\b|USERPROFILE|Path\.home|File\.expand_path|Dir\.home/;
/**
 * Code that can expand a wildcard held in a string, by a name-matching call or by starting a program. Anywhere else
 * `'*'` is plain text: a read of `'.e*'` looks for a file of that very name, and a fallback or a regex in a string is
 * no file at all. `spawn` counts with no shell too: Git's `cat` on Windows expands its own arguments.
 */
const EXPANDS = /glob|fnmatch|exec|spawn|system|popen|shell/i;
/** The same, in the words only one family has. A backtick starts a shell in ruby, perl and php; in js it is a string. */
const FAMILY_EXPANDS = {
    js: /(?:mini|micro|pico)match|Deno\.(?:Command|run)|\$`/,
    python: /subprocess|get(?:status)?output/,
    ruby: /\bDir\[|`|%x|Open3|\bopen\b/,
    perl: /`|\bqx\b|\bopen3?\b/,
    php: /`|passthru|proc_open/,
};
/** A string literal in code. */
const LITERAL = /(['"`])((?:\\.|(?!\1)[^\\\n])+)\1/g;
/**
 * What code run inline prints: an interpreter's `-e`/`-c` code, or the body it reads on stdin, that prints a secret
 * variable, the whole environment, or a file it names (in a string or as an argument). A script file is never read.
 */
export function inlineFindings(run, rules) {
    const interpreter = INTERPRETERS.get(run.name);
    const inline = interpreter === undefined ? undefined : inlineCode(run, interpreter);
    if (interpreter === undefined || inline === undefined) {
        return [];
    }
    const { family } = interpreter;
    const printed = inline.printOption ? [inline.code] : printedArguments(inline.code, PRINT_CALLS[family]);
    if (printed.length === 0) {
        return [];
    }
    const findings = DUMPS[family].test(inline.code) ? [{ kind: 'environment' }] : [];
    for (const name of printed.flatMap((text) => READS[family].flatMap((read) => [...text.matchAll(read)].map((match) => match.groups?.['name'] ?? '')))) {
        if (rules.names.secret(name)) {
            findings.push({ kind: 'variable', name });
        }
    }
    const place = { dialect: 'bash', dir: run.dir, home: rules.home };
    const homeJoined = HOME_HINT.test(inline.code);
    const named = (texts, names) => texts
        .filter((text) => (homeJoined ? [wordPath(text, place), `${rules.home}/${text}`] : [wordPath(text, place)]).some(names))
        .map((text) => ({ kind: 'file', path: text }));
    const expanded = (path) => rules.paths.mayName(path, true);
    const spelled = (path) => rules.paths.listed(path);
    const literals = [...inline.code.matchAll(LITERAL)].map(([, , body]) => (body ?? '').replace(/\\(.)/g, '$1'));
    const expands = EXPANDS.test(inline.code) || FAMILY_EXPANDS[family].test(inline.code);
    // A word after the code is the shell's, which expands it before the code runs, whatever the code does with it.
    return [...findings, ...named(literals, expands ? expanded : spelled), ...named(inline.argv, expanded)];
}
/** True when the call runs inline code that prints: with a print option, or a print call in the code. */
export function printsInline(run) {
    const interpreter = INTERPRETERS.get(run.name);
    const inline = interpreter === undefined ? undefined : inlineCode(run, interpreter);
    return interpreter !== undefined && inline !== undefined && (inline.printOption || inline.code.search(PRINT_CALLS[interpreter.family]) !== -1);
}
/** The code the call runs inline, or undefined when it runs a script file or nothing. */
function inlineCode(run, interpreter) {
    const texts = run.args.map((arg) => arg.text);
    let printOption = false;
    let code;
    const argv = [];
    let index = run.name === 'deno' ? texts.indexOf('eval') + 1 : 0;
    if (run.name === 'deno' && index === 0) {
        return undefined;
    }
    for (; index < texts.length; index += 1) {
        const text = texts[index] ?? '';
        const valued = /^(--eval|--print)=(.*)$/s.exec(text);
        const cluster = interpreter.clusters && /^-[a-zA-Z]+$/.test(text) ? clusterOptions(text.slice(1), interpreter.valued) : undefined;
        if (code !== undefined && !text.startsWith('-')) {
            argv.push(text);
        }
        else if (valued !== null) {
            code = valued[2];
            printOption ||= interpreter.print.includes(valued[1] ?? '');
        }
        else if (interpreter.code.includes(text) || (cluster !== undefined && interpreter.code.some((option) => cluster.endsWith(option.slice(1))))) {
            printOption ||= interpreter.print.includes(text) || (cluster?.includes('p') ?? false);
            code = texts[index + 1];
            index += 1;
        }
        else if (interpreter.print.includes(text) || (cluster?.includes('p') ?? false)) {
            printOption = true;
        }
        else if (run.name === 'deno' && code === undefined && !text.startsWith('-')) {
            code = text;
        }
        else if (!text.startsWith('-') || text === '-') {
            return text === '-' && run.stdin !== undefined ? { code: run.stdin.text, printOption, argv: texts.slice(index + 1) } : undefined;
        }
    }
    if (code === undefined) {
        return run.stdin === undefined ? undefined : { code: run.stdin.text, printOption, argv };
    }
    return { code, printOption, argv };
}
/** The option letters of a cluster: up to and with the first one whose value is the rest of the word. */
function clusterOptions(letters, valued) {
    const end = [...letters].findIndex((letter) => valued.includes(letter));
    return end === -1 ? letters : letters.slice(0, end + 1);
}
/** The argument text of each print call in the code: a parenthesised list, or the rest of the statement. */
function printedArguments(code, calls) {
    return [...code.matchAll(calls)].map((match) => {
        let start = (match.index ?? 0) + match[0].length;
        while (/\s/.test(code[start] ?? '')) {
            start += 1;
        }
        if (code[start] !== '(') {
            const end = code.slice(start).search(/[;\n}]/);
            return end === -1 ? code.slice(start) : code.slice(start, start + end);
        }
        let depth = 0;
        for (let index = start; index < code.length; index += 1) {
            depth += code[index] === '(' ? 1 : code[index] === ')' ? -1 : 0;
            if (depth === 0) {
                return code.slice(start + 1, index);
            }
        }
        return code.slice(start + 1);
    });
}
