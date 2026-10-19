/**
 * The team's time zone: the kit shows people every instant in it, marked with its zone ("14:20 IDT"), and reads
 * the times they type in it unless they mark them UTC. Stored instants stay ISO UTC.
 */

const MS_PER_DAY = 86_400_000;

/** A time on a zone's clock and calendar. Months run 1 to 12. */
export interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** A zone name of the `GMT+3` kind, which says the offset but not the zone. */
const OFFSET_NAME = /^GMT[+-]/;

/** A long zone name made of words, such as "Israel Daylight Time", whose initials name it. */
const WORDS_NAME = /^[A-Za-z]+(?: [A-Za-z]+)+$/;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function partOf(parts: readonly Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? '';
}

export class TimeZone {
  static readonly UTC = new TimeZone('UTC');

  /** The IANA name: `Asia/Jerusalem`. */
  readonly name: string;
  private readonly wallFormat: Intl.DateTimeFormat;
  private readonly shortName: Intl.DateTimeFormat;
  private readonly longName: Intl.DateTimeFormat;

  /** Throws a RangeError for a name the system's time zone data does not know: `TimeZone.of` checks first. */
  private constructor(name: string) {
    this.name = name;
    const options: Intl.DateTimeFormatOptions = {
      timeZone: name,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    };
    this.wallFormat = new Intl.DateTimeFormat('en-US', options);
    this.shortName = new Intl.DateTimeFormat('en-GB', { timeZone: name, timeZoneName: 'short' });
    this.longName = new Intl.DateTimeFormat('en-GB', { timeZone: name, timeZoneName: 'long' });
  }

  /** The zone of an IANA name such as `Asia/Jerusalem`, or undefined when the system does not know it. */
  static of(name: string): TimeZone | undefined {
    try {
      return new TimeZone(name);
    } catch (error) {
      if (error instanceof RangeError) {
        return undefined;
      }
      throw error;
    }
  }

  /** The team's zone: the config's `timeZone`, else the machine's; UTC should the system know neither. */
  static resolve(configured: string | undefined, machine: string): TimeZone {
    return TimeZone.of(configured ?? machine) ?? TimeZone.of(machine) ?? TimeZone.UTC;
  }

  /**
   * The zone's short name at an instant: `IDT`, `CEST`, `UTC`. Where the system names it only by its offset
   * (`GMT+3`), the initials of its long name ("Israel Daylight Time": `IDT`), else that offset.
   */
  label(date: Date): string {
    const short = partOf(this.shortName.formatToParts(date), 'timeZoneName');
    if (!OFFSET_NAME.test(short)) {
      return short;
    }
    const long = partOf(this.longName.formatToParts(date), 'timeZoneName');
    return WORDS_NAME.test(long) ? long.split(' ').map((word) => word.charAt(0).toUpperCase()).join('') : short;
  }

  /** The clock and calendar reading of an instant in this zone. */
  wall(date: Date): WallTime {
    const parts = this.wallFormat.formatToParts(date);
    return {
      year: Number(partOf(parts, 'year')),
      month: Number(partOf(parts, 'month')),
      day: Number(partOf(parts, 'day')),
      hour: Number(partOf(parts, 'hour')),
      minute: Number(partOf(parts, 'minute')),
    };
  }

  /** How far this zone's clock is ahead of UTC at an instant, in ms (negative west of Greenwich). */
  offsetMs(date: Date): number {
    const parts = this.wallFormat.formatToParts(date);
    const asUtc = Date.UTC(
      Number(partOf(parts, 'year')),
      Number(partOf(parts, 'month')) - 1,
      Number(partOf(parts, 'day')),
      Number(partOf(parts, 'hour')),
      Number(partOf(parts, 'minute')),
      Number(partOf(parts, 'second')),
    );
    return asUtc - (date.getTime() - date.getUTCMilliseconds());
  }

  /**
   * The instant this zone's clock shows a wall time at, `secondMs` past its minute. A time the clock shows twice
   * (as summer time ends) is the earlier; one it skips (as summer time starts) moves on by the skip, as a clock
   * set by hand would.
   */
  instant(wall: WallTime, secondMs = 0): Date {
    const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) + secondMs;
    const before = this.offsetMs(new Date(asUtc - MS_PER_DAY));
    const after = this.offsetMs(new Date(asUtc + MS_PER_DAY));
    const shown = [asUtc - before, asUtc - after].filter((ms) => this.sameMinute(this.wall(new Date(ms)), wall));
    return new Date(shown.length > 0 ? Math.min(...shown) : asUtc - before);
  }

  /** `YYYY-MM-DD` of the instant's day in this zone. */
  day(date: Date): string {
    const wall = this.wall(date);
    return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
  }

  /** `HH:MM IDT`: the instant's time on this zone's clock, with the zone. */
  clock(date: Date): string {
    const wall = this.wall(date);
    return `${pad(wall.hour)}:${pad(wall.minute)} ${this.label(date)}`;
  }

  /** `YYYY-MM-DD HH:MM IDT`. */
  minute(date: Date): string {
    return `${this.day(date)} ${this.clock(date)}`;
  }

  /** `MM-DD HH:MM IDT`, for compact lines. */
  shortMinute(date: Date): string {
    return this.minute(date).slice(5);
  }

  /** `YYYY-MM-DD HH:MM:SS IDT`, for a log line's stamp; every zone's offset today is whole minutes, so the seconds are UTC's. */
  second(date: Date): string {
    const wall = this.wall(date);
    return `${this.day(date)} ${pad(wall.hour)}:${pad(wall.minute)}:${pad(date.getUTCSeconds())} ${this.label(date)}`;
  }

  /** The instant's weekday in this zone: `Mon`. */
  weekday(date: Date): string {
    const wall = this.wall(date);
    return WEEKDAYS[new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay()] ?? '';
  }

  /** `Tue 10-20 01:30 IDT`, for an instant days away. */
  weekdayMinute(date: Date): string {
    return `${this.weekday(date)} ${this.shortMinute(date)}`;
  }

  /** A stretch of the day: `01:00-09:00 IDT`, or `01:00 IDT-08:00 IST` across a change of clocks. */
  clockSpan(from: Date, to: Date): string {
    const start = this.clock(from);
    const end = this.clock(to);
    const label = this.label(from);
    return label === this.label(to) ? `${start.slice(0, -label.length - 1)}-${end}` : `${start}-${end}`;
  }

  private sameMinute(a: WallTime, b: WallTime): boolean {
    return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;
  }
}
