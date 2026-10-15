import { KIT_NAME } from "../core/home.js";
/** Where the rest of the help is, after a command's own lines. */
export const FULL_HELP_POINTER = `Full help (team, session names, dates, exit codes): ${KIT_NAME} --help`;
/**
 * One command's help, read from the full help text so the two never drift. A block starts at a line
 * indented two spaces whose ` | `-separated parts each start with a command (`  set <id> ...`,
 * `  config validate | config migrate`); the deeper-indented lines under it belong to it. A usage error
 * prints only its command's blocks, so a mistyped line costs a few lines instead of the whole help.
 */
export class CommandHelp {
    head;
    blocks;
    commands;
    constructor(usage, commands) {
        const lines = usage.split('\n');
        this.head = lines.slice(0, 1).join('');
        this.commands = commands;
        const blocks = [];
        for (const line of lines.slice(1)) {
            const current = blocks.at(-1);
            if (/^ {2}\S/.test(line)) {
                blocks.push({ commands: this.named(line.slice(2)), lines: [line] });
            }
            else if (/^ {3,}\S/.test(line) && current !== undefined) {
                current.lines.push(line);
            }
        }
        this.blocks = blocks;
    }
    /** The commands a block's first line names. */
    named(text) {
        const parts = text.split(' | ');
        return this.commands.filter((command) => parts.some((part) => part === command || part.startsWith(`${command} `)));
    }
    /** The commands `name` covers: itself, or every command of a group word such as `inbox`. */
    covered(name) {
        return this.commands.filter((command) => command === name || command.startsWith(`${name} `));
    }
    /** The help lines of a command or a group word; none when it names neither. */
    linesOf(name) {
        const covered = this.covered(name);
        return this.blocks.filter((block) => block.commands.some((command) => covered.includes(command))).flatMap((block) => block.lines);
    }
    /** The commands no block names; a test keeps it empty, so every command has its own help. */
    undocumented() {
        return this.commands.filter((command) => this.linesOf(command).length === 0);
    }
    /**
     * `teamrig set --help`: the shape of a command line, the command's own lines and where the rest is.
     * A name that is no command or group word, or none, gets the command words there are instead.
     */
    forCommand(name) {
        const lines = name === undefined ? [] : this.linesOf(name);
        const words = [...new Set(this.commands.map((command) => command.replace(/ .*/, '')))];
        return [this.head, ...(lines.length > 0 ? lines : [`Commands: ${words.join(', ')}`]), FULL_HELP_POINTER].join('\n');
    }
    /** A line the CLI cannot read: the reason, then its command's help. */
    usageError(message, command) {
        return `${message}\n\n${this.forCommand(command)}`;
    }
}
