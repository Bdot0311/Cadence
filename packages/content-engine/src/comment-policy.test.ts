import { describe, expect, it } from 'vitest';
import {
  REPLY_DELAY_MAX_MINUTES,
  REPLY_DELAY_MIN_MINUTES,
  REPLY_MAX_CHARS,
  checkReplyLength,
  decideReply,
  isWithinActiveHours,
  nextActiveSlot,
  routeComment,
  type ActiveHours,
  type CommentClass,
} from './comment-policy.js';

const hours: ActiveHours = {
  timezone: 'America/New_York',
  startMinutes: 8 * 60, // 08:00
  endMinutes: 21 * 60, // 21:00
};

// 2026-08-17 is a Monday. 17:00Z = 13:00 EDT, mid-window.
const MIDDAY = new Date('2026-08-17T17:00:00Z');
// 07:00Z = 03:00 EDT, well outside.
const THREE_AM = new Date('2026-08-17T07:00:00Z');

describe('routing', () => {
  it('replies to questions and praise', () => {
    expect(routeComment('question')).toEqual({ kind: 'reply', source: 'generated' });
    expect(routeComment('praise')).toEqual({ kind: 'reply', source: 'generated' });
  });

  it('flags a lead signal and still replies', () => {
    expect(routeComment('lead-signal')).toEqual({ kind: 'flag-lead', alsoReply: true });
  });

  it('uses the objection library when one is configured', () => {
    expect(routeComment('objection', { hasObjectionLibrary: true })).toEqual({
      kind: 'reply',
      source: 'objection-library',
    });
  });

  it('stays silent on an objection with no library rather than improvising', () => {
    const a = routeComment('objection', { hasObjectionLibrary: false });
    expect(a.kind).toBe('ignore');
    if (a.kind !== 'ignore') return;
    expect(a.reason).toMatch(/arguing/);
  });

  it.each<CommentClass>(['spam', 'hostile'])('never replies to %s', (c) => {
    expect(routeComment(c, { hasObjectionLibrary: true }).kind).toBe('ignore');
  });

  it('has no configuration that makes it argue with a hostile comment', () => {
    for (const hasObjectionLibrary of [true, false]) {
      expect(routeComment('hostile', { hasObjectionLibrary }).kind).toBe('ignore');
    }
  });
});

describe('active hours', () => {
  it('accepts a midday instant and rejects 3am', () => {
    expect(isWithinActiveHours(MIDDAY, hours)).toBe(true);
    expect(isWithinActiveHours(THREE_AM, hours)).toBe(false);
  });

  it('handles a window that wraps past midnight', () => {
    const nightOwl: ActiveHours = {
      timezone: 'America/New_York',
      startMinutes: 22 * 60,
      endMinutes: 2 * 60,
    };
    // 03:00Z = 23:00 EDT previous day — inside 22:00-02:00.
    expect(isWithinActiveHours(new Date('2026-08-18T03:00:00Z'), nightOwl)).toBe(true);
    // 17:00Z = 13:00 EDT — outside.
    expect(isWithinActiveHours(MIDDAY, nightOwl)).toBe(false);
  });

  it('resolves timezone via Intl rather than a fixed offset', () => {
    // Same UTC hour, EST in January and EDT in August.
    const jan = new Date('2026-01-19T12:30:00Z'); // 07:30 EST — outside
    const aug = new Date('2026-08-17T12:30:00Z'); // 08:30 EDT — inside
    expect(isWithinActiveHours(jan, hours)).toBe(false);
    expect(isWithinActiveHours(aug, hours)).toBe(true);
  });
});

describe('nextActiveSlot', () => {
  it('returns the instant unchanged when already inside the window', () => {
    expect(nextActiveSlot(MIDDAY, hours).getTime()).toBe(MIDDAY.getTime());
  });

  it('pushes a 3am instant forward to the morning opening', () => {
    const slot = nextActiveSlot(THREE_AM, hours);
    expect(isWithinActiveHours(slot, hours)).toBe(true);
    expect(slot.getTime()).toBeGreaterThan(THREE_AM.getTime());
    // 08:00 EDT is 12:00Z — about five hours on.
    expect((slot.getTime() - THREE_AM.getTime()) / 3_600_000).toBeLessThan(6);
  });
});

describe('decideReply', () => {
  it('holds the reply for 20 to 90 minutes', () => {
    const min = decideReply({
      now: MIDDAY,
      thread: { weHaveReplied: false, directFollowUpSinceOurReply: false },
      activeHours: hours,
      random: () => 0,
    });
    const max = decideReply({
      now: MIDDAY,
      thread: { weHaveReplied: false, directFollowUpSinceOurReply: false },
      activeHours: hours,
      random: () => 0.999999,
    });

    expect(min.send && max.send).toBe(true);
    if (!min.send || !max.send) return;

    const minDelay = (min.sendAt.getTime() - MIDDAY.getTime()) / 60_000;
    const maxDelay = (max.sendAt.getTime() - MIDDAY.getTime()) / 60_000;
    expect(minDelay).toBe(REPLY_DELAY_MIN_MINUTES);
    expect(maxDelay).toBe(REPLY_DELAY_MAX_MINUTES);
  });

  it('never schedules a reply outside active hours', () => {
    // 20:45 EDT + up to 90 minutes would spill past the 21:00 close.
    const lateEvening = new Date('2026-08-18T00:45:00Z');
    for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
      const d = decideReply({
        now: lateEvening,
        thread: { weHaveReplied: false, directFollowUpSinceOurReply: false },
        activeHours: hours,
        random: () => r,
      });
      expect(d.send).toBe(true);
      if (!d.send) continue;
      expect(isWithinActiveHours(d.sendAt, hours), `random=${r}`).toBe(true);
    }
  });

  it('pushes rather than drops a reply that lands overnight', () => {
    const d = decideReply({
      now: THREE_AM,
      thread: { weHaveReplied: false, directFollowUpSinceOurReply: false },
      activeHours: hours,
      random: () => 0.5,
    });
    expect(d.send).toBe(true);
    if (!d.send) return;
    expect(isWithinActiveHours(d.sendAt, hours)).toBe(true);
  });

  it('refuses a second reply in a thread', () => {
    const d = decideReply({
      now: MIDDAY,
      thread: { weHaveReplied: true, directFollowUpSinceOurReply: false },
      activeHours: hours,
    });
    expect(d.send).toBe(false);
    if (d.send) return;
    expect(d.reason).toMatch(/talking to itself/);
  });

  it('allows a second reply only after a direct follow-up', () => {
    const d = decideReply({
      now: MIDDAY,
      thread: { weHaveReplied: true, directFollowUpSinceOurReply: true },
      activeHours: hours,
      random: () => 0.5,
    });
    expect(d.send).toBe(true);
  });
});

describe('reply length', () => {
  it('accepts a short reply', () => {
    expect(checkReplyLength('Good question. It scores on live intent first.')).toEqual({
      ok: true,
      overBy: 0,
    });
  });

  it('reports the overage instead of truncating', () => {
    const long = 'x'.repeat(REPLY_MAX_CHARS + 37);
    expect(checkReplyLength(long)).toEqual({ ok: false, overBy: 37 });
  });

  it('accepts a reply at exactly the ceiling', () => {
    expect(checkReplyLength('x'.repeat(REPLY_MAX_CHARS)).ok).toBe(true);
  });
});

// --- regression: the gate must not contradict the CTA policy ----------------
// Kept here rather than in a new file so it sits next to the other policy
// invariants. See slop-gate.ts `exemptionsFor`.

import { runSlopGate } from './slop-gate.js';
import type { ModelClient } from './model.js';

describe('slop gate exemptions', () => {
  function capturingModel() {
    let system = '';
    const model = {
      async text() {
        return { value: '', inputTokens: 0, outputTokens: 0, refusal: null };
      },
      async structured(args: { system: string }) {
        system = args.system;
        return {
          value: { violations: [] },
          inputTokens: 1,
          outputTokens: 1,
          refusal: null,
        };
      },
    } as unknown as ModelClient;
    return {
      model,
      get system() {
        return system;
      },
    };
  }

  // A draft with no layer-1 violations, so the critique pass actually runs.
  const CLEAN = [
    'Most cold email fails on the list, and no amount of copy rescues a bad list.',
    '',
    'Score the account on live intent signals first, then write to what the signal says.',
    '',
    'Comment "signal" and I will send you the scoring rubric.',
  ].join('\n');

  it('tells the critique pass the comment-gate CTA is required', async () => {
    const h = capturingModel();
    await runSlopGate({
      draft: CLEAN,
      model: h.model,
      ctaPolicy: { mechanic: 'comment_gate', productNameInBody: false },
    });

    expect(h.system).toMatch(/EXEMPTIONS/);
    expect(h.system).toMatch(/comment a specific word/);
    expect(h.system).toMatch(/not a formulaic closer and not a sales-pitch pivot/);
  });

  it('exempts the mandated lead-data phrasing from invented-specificity', async () => {
    const h = capturingModel();
    await runSlopGate({ draft: CLEAN, model: h.model });
    // The phrase must appear unbroken — wrapping it across lines is what this
    // test originally caught.
    expect(h.system).toMatch(
      /"verified contacts from public records and licensed data partnerships"/,
    );
    expect(h.system).toMatch(/not invented specificity/i);
  });

  it('omits the CTA exemption when no comment gate is configured', async () => {
    const h = capturingModel();
    await runSlopGate({
      draft: CLEAN,
      model: h.model,
      ctaPolicy: { mechanic: 'none', productNameInBody: true },
    });
    expect(h.system).not.toMatch(/comment a specific word/);
  });

  it('treats metaphorical-verb as advisory rather than blocking', async () => {
    const model = {
      async text() {
        return { value: '', inputTokens: 0, outputTokens: 0, refusal: null };
      },
      async structured() {
        return {
          value: {
            violations: [
              {
                code: 'metaphorical-verb',
                message: 'x',
                evidence: 'watching the inbox',
              },
            ],
          },
          inputTokens: 1,
          outputTokens: 1,
          refusal: null,
        };
      },
    } as unknown as ModelClient;

    const r = await runSlopGate({ draft: CLEAN, model });
    // Reported, but does not kill the draft.
    expect(r.violations.map((v) => v.code)).toContain('metaphorical-verb');
    expect(r.violations.find((v) => v.code === 'metaphorical-verb')?.severity).toBe(
      'clustering',
    );
    expect(r.pass).toBe(true);
  });
});
