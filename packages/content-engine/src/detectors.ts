/**
 * Deterministic slop detectors.
 *
 * Two layers guard every draft. This is layer one: regex and structural checks
 * that fire the same way every time, cost nothing, and cannot be talked out of
 * a verdict. Layer two is an LLM critique pass for the semantic patterns regex
 * can't see (negative parallelism in its dozens of shapes, patronising analogy,
 * invented specificity).
 *
 * Layer one runs first. A draft that fails here never reaches the model, which
 * makes the cheap check the fast path.
 *
 * Sources: the installed `anti-ai-slop-writing` skill (zero-instance patterns
 * and clustering references) plus the house hard-rejects from the build spec.
 */

export type Severity = 'zero-tolerance' | 'clustering';

export interface Violation {
  /** Stable id, so `gate_violations` rows stay queryable across prompt edits. */
  code: string;
  severity: Severity;
  message: string;
  /** The offending text, for the dashboard's killed-drafts view. */
  evidence: string;
}

interface Detector {
  code: string;
  severity: Severity;
  run(text: string): Violation[];
}

// --- helpers ----------------------------------------------------------------

const sentences = (t: string): string[] =>
  t
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

const lines = (t: string): string[] =>
  t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function hit(
  code: string,
  severity: Severity,
  message: string,
  evidence: string,
): Violation {
  return { code, severity, message, evidence: evidence.slice(0, 200) };
}

function matchAll(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[0]);
}

// --- house hard rejects (from the build spec) -------------------------------

/**
 * Em dashes and en dashes used as punctuation.
 *
 * The house rule is absolute: none in shipped prose. This is the single
 * highest-signal AI tell at a glance, and the founder's spec lists it as a hard
 * reject rather than a clustering concern.
 */
const emDash: Detector = {
  code: 'em-dash',
  severity: 'zero-tolerance',
  run(text) {
    const found = matchAll(text, /[—–]/g);
    return found.length === 0
      ? []
      : [
          hit(
            'em-dash',
            'zero-tolerance',
            `${found.length} em/en dash(es). Use commas, colons, or periods.`,
            text.slice(Math.max(0, text.search(/[—–]/) - 60), text.search(/[—–]/) + 60),
          ),
        ];
  },
};

/**
 * Negative parallelism: asserting what something IS by first saying what it
 * ISN'T, about the same subject.
 *
 * The skill calls this the single most recognisable tell and notes it hides in
 * dozens of shapes. Regex catches the common syntactic forms; the LLM pass
 * catches the rest. Deliberately no attempt to exempt the allowed
 * different-subject contrast here — layer two adjudicates that, and a false
 * positive costs one regeneration loop while a false negative ships.
 */
const negativeParallelism: Detector = {
  code: 'negative-parallelism',
  severity: 'zero-tolerance',
  run(text) {
    const patterns: RegExp[] = [
      /\bit'?s not\s+[^,.!?]{2,60},\s*it'?s\s+/gi,
      /\bnot just\s+[^,.!?]{2,60},\s*(but\s+)?/gi,
      /\bdon'?t just\s+[^,.!?]{2,60},\s+/gi,
      /\byou don'?t\s+[^,.!?]{2,60},\s*you\s+/gi,
      /\bisn'?t\s+(about\s+)?[^,.!?]{2,60},\s*it'?s\s+/gi,
      /\bit'?s less\s+[^,.!?]{2,60},\s*more\s+/gi,
      /\bnot\s+[^,.!?]{2,60}\.\s*(But\s+)?[A-Z]/g,
      /\bwas never\s+[^,.!?]{2,60},\s*it'?s\s+/gi,
      /\bon the surface[^,.!?]{0,40},\s*(but\s+)?underneath\b/gi,
      /\byou'?d expect\s+[^.!?]{2,60}\.\s*you get\b/gi,
    ];
    return patterns.flatMap((re) =>
      matchAll(text, re).map((m) =>
        hit(
          'negative-parallelism',
          'zero-tolerance',
          'Negative parallelism. Remove the negated half and state the claim directly.',
          m,
        ),
      ),
    );
  },
};

/** Triadic lists. The spec rejects these outright rather than rate-limiting them. */
const triadicList: Detector = {
  code: 'triadic-list',
  severity: 'zero-tolerance',
  run(text) {
    const out: Violation[] = [];
    for (const s of sentences(text)) {
      // Three or more comma-separated items in one sentence, optionally with a
      // trailing "and"/"or". Requires each item to be short, so a genuinely
      // long enumerative sentence isn't caught.
      if (/\b[\w'’]+(?:\s+[\w'’]+){0,3},\s+[\w'’]+(?:\s+[\w'’]+){0,3},\s+(and|or)?\s*[\w'’]+/i.test(s)) {
        out.push(
          hit('triadic-list', 'zero-tolerance', 'Rule-of-three list. Cut to one or two items, or rewrite as prose.', s),
        );
      }
    }
    return out;
  },
};

/** Humblebrag announcement openers. */
const announcementOpener: Detector = {
  code: 'announcement-opener',
  severity: 'zero-tolerance',
  run(text) {
    const re =
      /\b(i'?m\s+)?(so\s+|beyond\s+|incredibly\s+|really\s+)?(thrilled|excited|humbled|proud|delighted|honored|honoured)\s+to\s+(announce|share|reveal)/gi;
    return matchAll(text, re).map((m) =>
      hit(
        'announcement-opener',
        'zero-tolerance',
        'Humblebrag announcement opener. State the news, not your feelings about it.',
        m,
      ),
    );
  },
};

/** Rhetorical-question openers. */
const rhetoricalOpener: Detector = {
  code: 'rhetorical-opener',
  severity: 'zero-tolerance',
  run(text) {
    const first = lines(text)[0];
    if (first && first.endsWith('?')) {
      return [
        hit(
          'rhetorical-opener',
          'zero-tolerance',
          'Post opens on a rhetorical question. Open on the concrete observation instead.',
          first,
        ),
      ];
    }
    return [];
  },
};

/** Self-answered rhetorical questions anywhere in the body. */
const selfAnsweredQuestion: Detector = {
  code: 'self-answered-question',
  severity: 'zero-tolerance',
  run(text) {
    // "The result? Devastating." — a short question immediately answered.
    const re = /\b[A-Z][^.!?\n]{0,40}\?\s+[A-Z][^.!?\n]{0,60}[.!]/g;
    return matchAll(text, re).map((m) =>
      hit('self-answered-question', 'zero-tolerance', 'Self-answered rhetorical question. State the point.', m),
    );
  },
};

/**
 * Staccato blocks: runs of single-sentence lines.
 *
 * The spec's threshold is more than five consecutive lines. Short runs are a
 * legitimate LinkedIn rhythm; long ones are the format's most recognisable
 * machine cadence.
 */
const staccatoBlock: Detector = {
  code: 'staccato-block',
  severity: 'zero-tolerance',
  run(text) {
    const ls = lines(text);
    let run = 0;
    let start = 0;
    for (let i = 0; i <= ls.length; i++) {
      const l = ls[i];
      const isSingleSentence =
        l !== undefined && l.length < 120 && sentences(l).length === 1;
      if (isSingleSentence) {
        if (run === 0) start = i;
        run++;
        continue;
      }
      if (run > 5) {
        return [
          hit(
            'staccato-block',
            'zero-tolerance',
            `${run} consecutive single-sentence lines. Cap is 5. Fold some into paragraphs.`,
            ls.slice(start, start + run).join(' / '),
          ),
        ];
      }
      run = 0;
    }
    return [];
  },
};

// --- zero-instance patterns from the skill ----------------------------------

const falseSuspense: Detector = {
  code: 'false-suspense',
  severity: 'zero-tolerance',
  run(text) {
    const re =
      /\bhere'?s\s+(the\s+(thing|kicker|catch|part|reality)|what\s+(nobody|no one|most people|everyone)\s+\w+|what\s+changed)/gi;
    return matchAll(text, re).map((m) =>
      hit('false-suspense', 'zero-tolerance', 'False-suspense transition. Name the thing instead of teasing it.', m),
    );
  },
};

const colonSetup: Detector = {
  code: 'colon-setup',
  severity: 'zero-tolerance',
  run(text) {
    const re =
      /^\s*(the\s+)?(reality|problem|takeaway|truth|point|catch|result|lesson|kicker|upshot|bottom line)\s*:/gim;
    return matchAll(text, re).map((m) =>
      hit('colon-setup', 'zero-tolerance', 'Abstract-noun colon setup. State the point as a plain sentence.', m),
    );
  },
};

const patronisingAnalogy: Detector = {
  code: 'patronising-analogy',
  severity: 'zero-tolerance',
  run(text) {
    const re = /\b(think of it (like|as)|it'?s like|imagine if|picture this)\b/gi;
    return matchAll(text, re).map((m) =>
      hit('patronising-analogy', 'zero-tolerance', 'Patronising analogy. Name the thing directly.', m),
    );
  },
};

const pedagogicalFraming: Detector = {
  code: 'pedagogical-framing',
  severity: 'zero-tolerance',
  run(text) {
    const re = /\blet'?s\s+(unpack|dive in|dive into|break (this|it) down|explore|talk about)\b/gi;
    return matchAll(text, re).map((m) =>
      hit('pedagogical-framing', 'zero-tolerance', 'Teacher voice. Drop the framing and make the point.', m),
    );
  },
};

const vagueAuthority: Detector = {
  code: 'vague-authority',
  severity: 'zero-tolerance',
  run(text) {
    const re =
      /\b(research shows|studies (show|suggest)|experts say|industry reports indicate|data suggests|it'?s well known that)\b/gi;
    return matchAll(text, re).map((m) =>
      hit('vague-authority', 'zero-tolerance', 'Vague authority. Name the source or cut the claim.', m),
    );
  },
};

const formulaicOpener: Detector = {
  code: 'formulaic-opener',
  severity: 'zero-tolerance',
  run(text) {
    const re =
      /^\s*(in today'?s\s+\S+\s+world|in an age where|in a world where|more than ever|at its core|welcome to|enter\s+[A-Z])/gim;
    return matchAll(text, re).map((m) =>
      hit('formulaic-opener', 'zero-tolerance', 'Stock opening frame. Lead with the observation.', m),
    );
  },
};

const formulaicCloser: Detector = {
  code: 'formulaic-closer',
  severity: 'zero-tolerance',
  run(text) {
    const re = /\b(in conclusion|in summary|to sum up|ultimately|at the end of the day)\b/gi;
    return matchAll(text, re).map((m) =>
      hit('formulaic-closer', 'zero-tolerance', 'Announced conclusion. Make the last point and stop.', m),
    );
  },
};

const swapFraming: Detector = {
  code: 'swap-framing',
  severity: 'zero-tolerance',
  run(text) {
    const re = /\b(say goodbye to\s+[^,.]+,\s*say hello|out with the old)/gi;
    return matchAll(text, re).map((m) =>
      hit('swap-framing', 'zero-tolerance', 'Swap framing. State what changed.', m),
    );
  },
};

const forcedEmpathy: Detector = {
  code: 'forced-empathy',
  severity: 'zero-tolerance',
  run(text) {
    const re =
      /\b(you'?re not (imagining it|alone)|feeling \w+ is (normal|okay)|we'?ve all been there)\b/gi;
    return matchAll(text, re).map((m) =>
      hit('forced-empathy', 'zero-tolerance', 'Unsolicited validation. Open on the concrete thing.', m),
    );
  },
};

const emptyIntensifier: Detector = {
  code: 'empty-intensifier',
  severity: 'zero-tolerance',
  run(text) {
    const re = /\b(that|which|who)\s+(actually|genuinely|really)\s+(works?|helps?|matters?|delivers?)/gi;
    return matchAll(text, re).map((m) =>
      hit('empty-intensifier', 'zero-tolerance', 'Unearned contrast. Delete the intensifier.', m),
    );
  },
};

const phantomFuture: Detector = {
  code: 'phantom-future',
  severity: 'zero-tolerance',
  run(text) {
    const re =
      /\b(a (year|month|decade) from now,? you'?ll|by the time you realis[ez]e|you'?ll wish you'?d)\b/gi;
    return matchAll(text, re).map((m) =>
      hit('phantom-future', 'zero-tolerance', 'Phantom-future stakes. Use a present cost the reader already pays.', m),
    );
  },
};

// --- formatting tics --------------------------------------------------------

const decorativeUnicode: Detector = {
  code: 'decorative-unicode',
  severity: 'zero-tolerance',
  run(text) {
    // Emoji, arrows, ornamental symbols. Standard punctuation only.
    const re =
      /[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;
    const found = matchAll(text, re);
    return found.length === 0
      ? []
      : [
          hit(
            'decorative-unicode',
            'zero-tolerance',
            `Decorative unicode or emoji (${found.join(' ')}). Standard punctuation only.`,
            found.join(' '),
          ),
        ];
  },
};

const boldFirstBullets: Detector = {
  code: 'bold-first-bullets',
  severity: 'clustering',
  run(text) {
    const bullets = lines(text).filter((l) => /^([-*•]|\d+[.)])\s/.test(l));
    const bolded = bullets.filter((l) => /^([-*•]|\d+[.)])\s*\*\*[^*]+\*\*\s*:/.test(l));
    return bolded.length >= 2
      ? [
          hit(
            'bold-first-bullets',
            'clustering',
            `${bolded.length} bullets opening with a bolded phrase plus colon.`,
            bolded[0] ?? '',
          ),
        ]
      : [];
  },
};

const anaphora: Detector = {
  code: 'anaphora',
  severity: 'clustering',
  run(text) {
    const ss = sentences(text);
    let run = 1;
    for (let i = 1; i <= ss.length; i++) {
      const prev = ss[i - 1]?.split(/\s+/)[0]?.toLowerCase();
      const cur = ss[i]?.split(/\s+/)[0]?.toLowerCase();
      if (prev && cur && prev === cur) {
        run++;
        if (run >= 3) {
          return [
            hit('anaphora', 'clustering', `Same sentence opener "${cur}" ${run} times in a row.`, ss.slice(i - run + 1, i + 1).join(' ')),
          ];
        }
      } else {
        run = 1;
      }
    }
    return [];
  },
};

/**
 * House banned words. Enforced at zero tolerance per the skill's guidance that
 * a short absolute list beats a long "use sparingly" one.
 */
export const HOUSE_BANNED_WORDS = [
  'transformative',
  'game-changing',
  'game changing',
  'revolutionary',
  'seamless',
  'seamlessly',
  'robust',
  'best-in-class',
  'industry-leading',
  'cutting-edge',
  'leverage',
  'delve',
  'unlock',
  'foster',
  'elevate',
  'empower',
  'streamline',
  'supercharge',
  'don’t hesitate',
  "don't hesitate",
  'seismic',
  'paradigm',
  'synergy',
  'tapestry',
] as const;

const bannedWords: Detector = {
  code: 'banned-word',
  severity: 'zero-tolerance',
  run(text) {
    const out: Violation[] = [];
    for (const w of HOUSE_BANNED_WORDS) {
      const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      for (const m of matchAll(text, re)) {
        out.push(hit('banned-word', 'zero-tolerance', `House banned word: "${m}".`, m));
      }
    }
    return out;
  },
};

// --- registry ---------------------------------------------------------------

const DETECTORS: Detector[] = [
  emDash,
  negativeParallelism,
  triadicList,
  announcementOpener,
  rhetoricalOpener,
  selfAnsweredQuestion,
  staccatoBlock,
  falseSuspense,
  colonSetup,
  patronisingAnalogy,
  pedagogicalFraming,
  vagueAuthority,
  formulaicOpener,
  formulaicCloser,
  swapFraming,
  forcedEmpathy,
  emptyIntensifier,
  phantomFuture,
  decorativeUnicode,
  boldFirstBullets,
  anaphora,
  bannedWords,
];

/**
 * Run every deterministic detector. Returns all violations rather than
 * short-circuiting on the first, so a regeneration loop can fix everything in
 * one pass instead of discovering problems one at a time.
 */
export function detectSlop(text: string): Violation[] {
  return DETECTORS.flatMap((d) => d.run(text));
}

/** Zero-tolerance violations fail the gate outright. */
export function hasBlockingViolations(v: Violation[]): boolean {
  return v.some((x) => x.severity === 'zero-tolerance');
}
