/**
 * What to do about an inbound comment, and when.
 *
 * Pure functions: no clock reads, no I/O, no model calls. The classifier
 * (which does call a model) decides *what a comment is*; this decides *what we
 * do about it*. Keeping the second half deterministic means the rules that
 * matter most — never argue, never reply twice, never reply at 4am — are
 * testable and cannot be talked out of a verdict by a model having a bad day.
 */

export type CommentClass =
  | 'question'
  | 'objection'
  | 'praise'
  | 'spam'
  | 'lead-signal'
  | 'hostile';

export type CommentAction =
  | { kind: 'reply'; source: 'generated' }
  | { kind: 'reply'; source: 'objection-library' }
  | { kind: 'ignore'; reason: string }
  | { kind: 'flag-lead'; alsoReply: boolean };

/** Comment replies are short. This is a hard ceiling, not a suggestion. */
export const REPLY_MAX_CHARS = 400;

/** Randomized hold before a reply goes out. */
export const REPLY_DELAY_MIN_MINUTES = 20;
export const REPLY_DELAY_MAX_MINUTES = 90;

/**
 * Routing table.
 *
 * The two `ignore` rows are the important ones. The agent does not argue with
 * anyone, ever — not a softened reply, not a de-escalating reply, no reply.
 * There is no configuration that turns this on, because every version of
 * "handle it gracefully" is still the company account arguing in public, and
 * the downside is unbounded while the upside is a comment nobody reads.
 */
export function routeComment(
  classification: CommentClass,
  opts: { hasObjectionLibrary: boolean } = { hasObjectionLibrary: false },
): CommentAction {
  switch (classification) {
    case 'question':
    case 'praise':
      return { kind: 'reply', source: 'generated' };

    case 'lead-signal':
      // Reply AND flag. The reply keeps the conversation warm; the lead row is
      // what the founder actually acts on.
      return { kind: 'flag-lead', alsoReply: true };

    case 'objection':
      return opts.hasObjectionLibrary
        ? { kind: 'reply', source: 'objection-library' }
        : {
            kind: 'ignore',
            reason:
              'Objection with no configured objection-library entry. Improvising a ' +
              'rebuttal in public is how the account ends up arguing.',
          };

    case 'spam':
      return { kind: 'ignore', reason: 'Spam. Logged and left alone.' };

    case 'hostile':
      return {
        kind: 'ignore',
        reason:
          'Hostile. The agent does not argue with anyone, ever. Logged for the ' +
          'digest so the founder can decide whether to respond personally.',
      };
  }
}

export interface ActiveHours {
  timezone: string;
  /** Minutes from local midnight. */
  startMinutes: number;
  endMinutes: number;
}

export interface ThreadState {
  /** Have we already replied anywhere in this thread? */
  weHaveReplied: boolean;
  /**
   * Did the person ask a direct follow-up AFTER our reply? The only condition
   * under which a second reply is allowed.
   */
  directFollowUpSinceOurReply: boolean;
}

export type ReplyDecision =
  | { send: false; reason: string }
  | { send: true; sendAt: Date };

/** Local wall-clock minutes in a timezone, DST-correct via Intl. */
export function localMinutes(at: Date, timezone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;

  const hour = Number(parts['hour'] === '24' ? '0' : parts['hour']);
  return hour * 60 + Number(parts['minute']);
}

export function isWithinActiveHours(at: Date, hours: ActiveHours): boolean {
  const m = localMinutes(at, hours.timezone);
  // Handles windows that wrap past midnight, e.g. 22:00-02:00.
  return hours.startMinutes <= hours.endMinutes
    ? m >= hours.startMinutes && m <= hours.endMinutes
    : m >= hours.startMinutes || m <= hours.endMinutes;
}

/** Next instant inside the active window, at or after `from`. */
export function nextActiveSlot(from: Date, hours: ActiveHours): Date {
  let cursor = new Date(from);
  // Step in 15-minute increments rather than computing an offset, so DST
  // transitions inside the search window resolve correctly.
  for (let i = 0; i < 4 * 24 * 2; i++) {
    if (isWithinActiveHours(cursor, hours)) return cursor;
    cursor = new Date(cursor.getTime() + 15 * 60_000);
  }
  return cursor;
}

/**
 * Whether to reply, and when.
 *
 * The delay is randomized in a 20-90 minute band. The reason is that instant
 * replies read as automation and get skimmed past; a reply that arrives while
 * the commenter is still in their session but not within seconds reads like a
 * person who saw the notification. If the slot lands outside active hours it
 * is pushed to the next opening rather than dropped, because a good reply the
 * next morning still lands and a 4am reply does not.
 */
export function decideReply(args: {
  now: Date;
  thread: ThreadState;
  activeHours: ActiveHours;
  random?: () => number;
}): ReplyDecision {
  const random = args.random ?? Math.random;

  if (args.thread.weHaveReplied && !args.thread.directFollowUpSinceOurReply) {
    return {
      send: false,
      reason:
        'Already replied in this thread and no direct follow-up since. Replying ' +
        'again would be the account talking to itself.',
    };
  }

  const span = REPLY_DELAY_MAX_MINUTES - REPLY_DELAY_MIN_MINUTES;
  const delayMinutes = REPLY_DELAY_MIN_MINUTES + Math.floor(random() * (span + 1));
  const target = new Date(args.now.getTime() + delayMinutes * 60_000);

  return { send: true, sendAt: nextActiveSlot(target, args.activeHours) };
}

/**
 * Truncation is NOT the fix for an over-long reply — a reply cut mid-sentence
 * is worse than a short one. This reports the overage so the caller can
 * regenerate with the ceiling restated.
 */
export function checkReplyLength(text: string): { ok: boolean; overBy: number } {
  const overBy = text.length - REPLY_MAX_CHARS;
  return { ok: overBy <= 0, overBy: Math.max(0, overBy) };
}
