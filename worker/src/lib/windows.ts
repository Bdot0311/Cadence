/**
 * Publishing windows, spacing, caps, and in-window jitter.
 *
 * WHY THIS EXISTS — read before changing any number here.
 *
 * These rules are about ENGAGEMENT QUALITY, not about how the API is called.
 * Six posts fired at 03:14 perform badly and read as spam to actual humans.
 * Posts land when the audience is awake or they do not land at all. That is the
 * entire argument for windows, spacing, and daily caps.
 *
 * Rate-limit backoff is a SEPARATE concern living in packages/linkedin-client:
 * that one is ordinary good-API-citizen hygiene, and it exists whether or not
 * a human ever reads the post. The two share a scheduler but not a rationale.
 * Do not "optimize away" the human-timing rules on the theory that they were
 * about throttles. They were not.
 *
 * Pure functions, no I/O, no clock reads — the caller passes `now`. That makes
 * every rule here testable without mocking time.
 */

export interface Window {
  /** ISO weekday, 1 = Monday .. 7 = Sunday. */
  day: number;
  /** "HH:MM" in the account's configured timezone. */
  start: string;
  end: string;
}

export interface ScheduleConfig {
  timezone: string;
  windows: Window[];
  /** Minimum gap between two posts on the same account. */
  minGapMinutes: number;
  dailyCap: number;
  weeklyCap: number;
  /** Randomized offset inside the window so publish times aren't clock-identical. */
  jitterMinutes: number;
}

export interface PublishedPost {
  publishedAt: Date;
}

export type SlotDecision =
  | { ok: true; scheduledAt: Date }
  | { ok: false; reason: string };

/** Minutes since local midnight for a "HH:MM" string. */
function parseHHMM(s: string): number {
  const [h, m] = s.split(':').map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) {
    throw new Error(`Invalid time "${s}", expected HH:MM`);
  }
  return h * 60 + m;
}

/**
 * Local wall-clock parts for an instant in a given IANA timezone.
 *
 * Uses Intl rather than manual offset arithmetic so DST transitions are handled
 * by the platform. A hand-rolled UTC offset silently drifts by an hour twice a
 * year, which would move every post out of its window.
 */
export function localParts(
  at: Date,
  timezone: string,
): { weekday: number; minutes: number; ymd: string } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour12: false,
  });

  const parts = Object.fromEntries(
    fmt.formatToParts(at).map((p) => [p.type, p.value]),
  ) as Record<string, string>;

  const weekdayMap: Record<string, number> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  };

  const hour = Number(parts['hour'] === '24' ? '0' : parts['hour']);
  return {
    weekday: weekdayMap[parts['weekday'] ?? 'Mon'] ?? 1,
    minutes: hour * 60 + Number(parts['minute']),
    ymd: `${parts['year']}-${parts['month']}-${parts['day']}`,
  };
}

/** Is `at` inside any configured publishing window? */
export function isInWindow(at: Date, cfg: ScheduleConfig): boolean {
  const { weekday, minutes } = localParts(at, cfg.timezone);
  return cfg.windows.some(
    (w) =>
      w.day === weekday &&
      minutes >= parseHHMM(w.start) &&
      minutes <= parseHHMM(w.end),
  );
}

/** Posts published on the same local calendar day as `at`. */
export function countSameLocalDay(
  posts: PublishedPost[],
  at: Date,
  timezone: string,
): number {
  const target = localParts(at, timezone).ymd;
  return posts.filter((p) => localParts(p.publishedAt, timezone).ymd === target)
    .length;
}

/** Posts published within the trailing 7 days of `at`. */
export function countTrailingWeek(posts: PublishedPost[], at: Date): number {
  const cutoff = at.getTime() - 7 * 24 * 60 * 60 * 1000;
  return posts.filter((p) => p.publishedAt.getTime() > cutoff).length;
}

/**
 * Decide whether a post may go out at `now`, and at exactly what time.
 *
 * Returns the jittered instant rather than `now` so publish times are not
 * clock-identical day to day. The jitter is bounded by the window: a post never
 * gets pushed past the window's end just to satisfy the offset.
 */
export function findSlot(args: {
  now: Date;
  cfg: ScheduleConfig;
  published: PublishedPost[];
  /** A human-selected time may bypass the cadence window. */
  ignoreWindow?: boolean;
  /** Explicit Post now / Schedule choices override automatic cadence pacing. */
  ignorePacing?: boolean;
  /** Injectable for tests. */
  random?: () => number;
  /** Set when the account is cooling down after a badly underperforming post. */
  cooldownUntil?: Date | null;
}): SlotDecision {
  const { now, cfg, published } = args;
  const random = args.random ?? Math.random;

  if (args.cooldownUntil && now < args.cooldownUntil) {
    return {
      ok: false,
      reason: `Account is in post-underperformance cooldown until ${args.cooldownUntil.toISOString()}.`,
    };
  }

  if (!args.ignoreWindow && !isInWindow(now, cfg)) {
    return { ok: false, reason: 'Outside every configured publishing window.' };
  }

  if (!args.ignorePacing) {
    const today = countSameLocalDay(published, now, cfg.timezone);
    if (today >= cfg.dailyCap) {
      return { ok: false, reason: `Daily cap reached (${today}/${cfg.dailyCap}).` };
    }

    const week = countTrailingWeek(published, now);
    if (week >= cfg.weeklyCap) {
      return { ok: false, reason: `Weekly cap reached (${week}/${cfg.weeklyCap}).` };
    }

    const last = published.reduce<Date | null>(
      (acc, p) => (acc === null || p.publishedAt > acc ? p.publishedAt : acc),
      null,
    );
    if (last) {
      const gapMinutes = (now.getTime() - last.getTime()) / 60_000;
      if (gapMinutes < cfg.minGapMinutes) {
        return {
          ok: false,
          reason: `Only ${Math.floor(gapMinutes)}m since the last post; minimum gap is ${cfg.minGapMinutes}m.`,
        };
      }
    }
  }

  // Human-selected times are exact. Automatic cadence receives bounded jitter.
  if (args.ignoreWindow) return { ok: true, scheduledAt: now };

  // Jitter forward, clamped so we never spill past the window's end.
  const { weekday, minutes } = localParts(now, cfg.timezone);
  const win = cfg.windows.find(
    (w) => w.day === weekday && minutes >= parseHHMM(w.start) && minutes <= parseHHMM(w.end),
  );
  const remainingInWindow = win ? parseHHMM(win.end) - minutes : 0;
  const offset = Math.floor(random() * Math.min(cfg.jitterMinutes, remainingInWindow));

  return { ok: true, scheduledAt: new Date(now.getTime() + offset * 60_000) };
}
