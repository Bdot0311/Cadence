import { describe, expect, it } from 'vitest';
import { detectSlop, hasBlockingViolations } from './detectors.js';

const codes = (t: string) => detectSlop(t).map((v) => v.code);

describe('house hard rejects', () => {
  it('flags em and en dashes', () => {
    expect(codes('We shipped the SDR agent — it books meetings.')).toContain('em-dash');
    expect(codes('Three cohorts – all the same.')).toContain('em-dash');
  });

  it('leaves hyphens alone', () => {
    expect(codes('A signal-first, reply-engineered approach.')).not.toContain('em-dash');
  });

  it('flags negative parallelism in several shapes', () => {
    const shapes = [
      "It's not a volume problem, it's a targeting problem.",
      'Not just more email, better email.',
      "Don't just send sequences, engineer replies.",
      "You don't buy software, you buy certainty.",
      "It's less about volume, more about signal.",
    ];
    for (const s of shapes) {
      expect(codes(s), s).toContain('negative-parallelism');
    }
  });

  it('flags triadic lists', () => {
    expect(codes('We build fast, ship often, and learn constantly.')).toContain('triadic-list');
  });

  it('flags announcement openers', () => {
    expect(codes("I'm excited to announce our new pricing.")).toContain('announcement-opener');
    expect(codes('Thrilled to share what we built.')).toContain('announcement-opener');
    expect(codes('Beyond excited to announce this.')).toContain('announcement-opener');
  });

  it('flags a rhetorical question opener but not a mid-post question', () => {
    expect(codes('What if outbound actually worked?\n\nWe rebuilt it.')).toContain(
      'rhetorical-opener',
    );
    expect(codes('We rebuilt outbound.\n\nSo what changed for reply rates over the quarter?')).not.toContain(
      'rhetorical-opener',
    );
  });

  it('flags staccato blocks over five lines but allows five', () => {
    const six = ['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.'].join('\n');
    const five = ['One.', 'Two.', 'Three.', 'Four.', 'Five.'].join('\n');
    expect(codes(six)).toContain('staccato-block');
    expect(codes(five)).not.toContain('staccato-block');
  });
});

describe('zero-instance patterns from the skill', () => {
  it.each([
    ["Here's the thing nobody tells you about outbound.", 'false-suspense'],
    ['The takeaway: most sequences never get read.', 'colon-setup'],
    ['Think of it like a funnel with a hole in it.', 'patronising-analogy'],
    ["Let's unpack why reply rates collapsed.", 'pedagogical-framing'],
    ['Research shows most cold email fails.', 'vague-authority'],
    ["In today's fast-paced world, outbound is hard.", 'formulaic-opener'],
    ['In conclusion, signal beats volume.', 'formulaic-closer'],
    ['Say goodbye to spray and pray, say hello to signal.', 'swap-framing'],
    ["You're not imagining it. Outbound got harder.", 'forced-empathy'],
    ['A playbook that actually works.', 'empty-intensifier'],
    ["A year from now you'll wish you'd started.", 'phantom-future'],
    ['The result? Nothing.', 'self-answered-question'],
  ])('flags %j as %s', (text, code) => {
    expect(codes(text)).toContain(code);
  });
});

describe('formatting tics', () => {
  it('flags emoji and arrows', () => {
    expect(codes('We shipped it 🚀')).toContain('decorative-unicode');
    expect(codes('Leads → meetings')).toContain('decorative-unicode');
  });

  it('flags repeated bold-first bullets', () => {
    const t = ['- **Speed**: we ship weekly', '- **Signal**: we score intent'].join('\n');
    expect(codes(t)).toContain('bold-first-bullets');
  });

  it('flags anaphora at three repeats', () => {
    const t = 'You tried lists. You tried sequences. You tried volume.';
    expect(codes(t)).toContain('anaphora');
  });

  it('does not flag anaphora at two repeats', () => {
    expect(codes('You tried lists. You tried sequences. Then you stopped.')).not.toContain(
      'anaphora',
    );
  });
});

describe('house banned words', () => {
  it.each([
    'This is a transformative approach.',
    'A seamless workflow.',
    'We leverage intent data.',
    'Robust infrastructure.',
    "Let me delve into the numbers.",
  ])('flags %j', (text) => {
    expect(codes(text)).toContain('banned-word');
  });
});

describe('gate verdict', () => {
  it('blocks on any zero-tolerance violation', () => {
    expect(hasBlockingViolations(detectSlop('It — works.'))).toBe(true);
  });

  it('does not block on clustering-only violations', () => {
    const v = detectSlop('You tried lists. You tried sequences. You tried volume.');
    expect(v.every((x) => x.severity === 'clustering')).toBe(true);
    expect(hasBlockingViolations(v)).toBe(false);
  });

  it('passes clean copy in the founder register', () => {
    const clean = [
      'Most cold email fails because the list is wrong, and no amount of copy fixes a bad list.',
      '',
      'We rebuilt Outreign around that. Score the account on live intent signals first, then write to what the signal says.',
      '',
      'Reply rates went up. The sending volume went down.',
    ].join('\n');

    const v = detectSlop(clean);
    expect(v, JSON.stringify(v, null, 2)).toEqual([]);
  });

  it('reports every violation rather than stopping at the first', () => {
    const bad = "I'm excited to announce — it's not volume, it's signal.";
    const found = new Set(codes(bad));
    expect(found.has('announcement-opener')).toBe(true);
    expect(found.has('em-dash')).toBe(true);
    expect(found.has('negative-parallelism')).toBe(true);
  });
});
