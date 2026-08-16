import { describe, expect, it } from 'vitest';
import {
  countSameLocalDay,
  countTrailingWeek,
  findSlot,
  isInWindow,
  localParts,
  type ScheduleConfig,
} from './windows.js';

const cfg: ScheduleConfig = {
  timezone: 'America/New_York',
  windows: [
    // Weekday mornings, 08:30-11:00 local.
    { day: 1, start: '08:30', end: '11:00' },
    { day: 2, start: '08:30', end: '11:00' },
    { day: 3, start: '08:30', end: '11:00' },
    { day: 4, start: '08:30', end: '11:00' },
    { day: 5, start: '08:30', end: '11:00' },
  ],
  minGapMinutes: 240,
  dailyCap: 2,
  weeklyCap: 7,
  jitterMinutes: 12,
};

// 2026-08-17 is a Monday. 13:00Z = 09:00 EDT, inside the window.
const MON_9AM = new Date('2026-08-17T13:00:00Z');
const MON_3AM = new Date('2026-08-17T07:00:00Z'); // 03:00 EDT
const SAT_9AM = new Date('2026-08-15T13:00:00Z'); // Saturday

describe('localParts', () => {
  it('resolves weekday and local minutes in the configured timezone', () => {
    const p = localParts(MON_9AM, 'America/New_York');
    expect(p.weekday).toBe(1);
    expect(p.minutes).toBe(9 * 60);
    expect(p.ymd).toBe('2026-08-17');
  });

  it('handles the DST offset rather than assuming a fixed one', () => {
    // January is EST (UTC-5), August is EDT (UTC-4). Same UTC hour, different
    // local hour. A hand-rolled offset would silently drift here.
    const jan = localParts(new Date('2026-01-19T13:00:00Z'), 'America/New_York');
    const aug = localParts(new Date('2026-08-17T13:00:00Z'), 'America/New_York');
    expect(jan.minutes).toBe(8 * 60);
    expect(aug.minutes).toBe(9 * 60);
  });
});

describe('isInWindow', () => {
  it('accepts a weekday morning inside the window', () => {
    expect(isInWindow(MON_9AM, cfg)).toBe(true);
  });

  it('rejects 3am — the case the whole rule exists for', () => {
    expect(isInWindow(MON_3AM, cfg)).toBe(false);
  });

  it('rejects a weekend with no configured window', () => {
    expect(isInWindow(SAT_9AM, cfg)).toBe(false);
  });

  it('includes both window boundaries', () => {
    // 12:30Z = 08:30 EDT, 15:00Z = 11:00 EDT
    expect(isInWindow(new Date('2026-08-17T12:30:00Z'), cfg)).toBe(true);
    expect(isInWindow(new Date('2026-08-17T15:00:00Z'), cfg)).toBe(true);
    expect(isInWindow(new Date('2026-08-17T15:01:00Z'), cfg)).toBe(false);
  });
});

describe('caps', () => {
  it('counts by local calendar day, not UTC day', () => {
    // 2026-08-18T01:00Z is still 2026-08-17 in New York.
    const posts = [{ publishedAt: new Date('2026-08-18T01:00:00Z') }];
    expect(countSameLocalDay(posts, MON_9AM, cfg.timezone)).toBe(1);
  });

  it('counts a trailing 7-day window, not a calendar week', () => {
    const posts = [
      { publishedAt: new Date('2026-08-11T13:00:00Z') }, // 6 days before
      { publishedAt: new Date('2026-08-09T13:00:00Z') }, // 8 days before
    ];
    expect(countTrailingWeek(posts, MON_9AM)).toBe(1);
  });
});

describe('findSlot', () => {
  const slot = (o: Parameters<typeof findSlot>[0]) => findSlot({ random: () => 0, ...o });

  it('allows a post inside the window with nothing published', () => {
    const d = slot({ now: MON_9AM, cfg, published: [] });
    expect(d.ok).toBe(true);
  });

  it('refuses outside the window', () => {
    const d = slot({ now: MON_3AM, cfg, published: [] });
    expect(d).toMatchObject({ ok: false });
    if (!d.ok) expect(d.reason).toMatch(/Outside every configured publishing window/);
  });

  it('refuses at the daily cap', () => {
    const published = [
      { publishedAt: new Date('2026-08-17T12:35:00Z') },
      { publishedAt: new Date('2026-08-17T12:40:00Z') },
    ];
    const d = slot({ now: MON_9AM, cfg, published });
    expect(d).toMatchObject({ ok: false });
    if (!d.ok) expect(d.reason).toMatch(/Daily cap reached \(2\/2\)/);
  });

  it('refuses at the weekly cap', () => {
    const published = Array.from({ length: 7 }, (_, i) => ({
      publishedAt: new Date(`2026-08-1${i + 1}T02:00:00Z`),
    }));
    const d = slot({ now: MON_9AM, cfg: { ...cfg, dailyCap: 99 }, published });
    expect(d).toMatchObject({ ok: false });
    if (!d.ok) expect(d.reason).toMatch(/Weekly cap reached/);
  });

  it('refuses inside the minimum gap', () => {
    // 30 minutes ago; minimum gap is 240.
    const published = [{ publishedAt: new Date('2026-08-17T12:30:00Z') }];
    const d = slot({ now: MON_9AM, cfg, published });
    expect(d).toMatchObject({ ok: false });
    if (!d.ok) expect(d.reason).toMatch(/minimum gap is 240m/);
  });

  it('refuses during an underperformance cooldown', () => {
    const d = slot({
      now: MON_9AM,
      cfg,
      published: [],
      cooldownUntil: new Date('2026-08-18T00:00:00Z'),
    });
    expect(d).toMatchObject({ ok: false });
    if (!d.ok) expect(d.reason).toMatch(/cooldown/);
  });

  it('applies a randomized in-window offset so times are not clock-identical', () => {
    const a = findSlot({ now: MON_9AM, cfg, published: [], random: () => 0 });
    const b = findSlot({ now: MON_9AM, cfg, published: [], random: () => 0.99 });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.scheduledAt.getTime()).toBe(MON_9AM.getTime());
    expect(b.scheduledAt.getTime()).toBeGreaterThan(MON_9AM.getTime());
    const offsetMinutes = (b.scheduledAt.getTime() - MON_9AM.getTime()) / 60_000;
    expect(offsetMinutes).toBeLessThanOrEqual(cfg.jitterMinutes);
  });

  it('clamps the jitter so a post never spills past the window end', () => {
    // 14:55Z = 10:55 EDT, 5 minutes before the 11:00 close. Jitter is 12.
    const nearClose = new Date('2026-08-17T14:55:00Z');
    const d = findSlot({ now: nearClose, cfg, published: [], random: () => 0.99 });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const offsetMinutes = (d.scheduledAt.getTime() - nearClose.getTime()) / 60_000;
    expect(offsetMinutes).toBeLessThanOrEqual(5);
  });
});
