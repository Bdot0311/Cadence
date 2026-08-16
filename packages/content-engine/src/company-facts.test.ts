import { describe, expect, it } from 'vitest';
import { checkFacts, hasRejects } from './company-facts.js';

const check = (text: string) => checkFacts({ text });
const codes = (text: string) => check(text).map((v) => v.code);

describe('Outreign is email outbound only', () => {
  it.each([
    'Our cold call sequences book meetings.',
    'The dialer runs while you sleep.',
    'Outreign handles phone outreach too.',
    'A voice agent that qualifies leads.',
    'Ringless voicemail drops.',
  ])('rejects %j', (text) => {
    const v = check(text);
    expect(v.map((x) => x.code)).toContain('outreign-is-email-only');
    expect(hasRejects(v)).toBe(true);
  });

  it('allows email-only description', () => {
    expect(codes('The AI SDR agent monitors Gmail and books via Calendly.')).not.toContain(
      'outreign-is-email-only',
    );
  });
});

describe('unbuilt features', () => {
  it.each([
    'ICP Builder',
    'Unified Inbox',
    'Deliverability Dashboard',
    'Signal Lead Queue',
    'Email Quality Checker',
  ])('rejects a live claim for %s', (feature) => {
    const v = check(`Try the new ${feature} today.`);
    expect(v.map((x) => x.code)).toContain('unbuilt-feature');
    expect(hasRejects(v)).toBe(true);
  });

  it('allows live features', () => {
    const v = check('AI lead scoring and the workflow builder are live today.');
    expect(v).toEqual([]);
  });
});

describe('CRM sync status', () => {
  it('flags HubSpot presented as live', () => {
    expect(codes('Syncs to HubSpot out of the box.')).toContain('unshipped-crm');
  });

  it('allows HubSpot when framed as shipping soon', () => {
    expect(codes('HubSpot sync is shipping soon.')).not.toContain('unshipped-crm');
  });

  it('does not flag Gmail, which is live', () => {
    expect(codes('Gmail sync is live.')).toEqual([]);
  });
});

describe('lead data provider disclosure', () => {
  it.each(['Apollo', 'ZoomInfo', 'Clearbit', 'Cognism', 'RocketReach'])(
    'rejects naming %s',
    (provider) => {
      const v = check(`We enrich from ${provider}.`);
      expect(v.map((x) => x.code)).toContain('lead-provider-named');
      expect(hasRejects(v)).toBe(true);
    },
  );

  it('allows the sanctioned phrasing', () => {
    const v = check(
      'Verified contacts from public records and licensed data partnerships, plus live intent signals.',
    );
    expect(v).toEqual([]);
  });
});

describe('out-of-portfolio businesses', () => {
  it.each(['DreamScape Events', 'Kora AI', 'credit memo'])('rejects %j', (name) => {
    const v = check(`I also work on ${name}.`);
    expect(v.map((x) => x.code)).toContain('out-of-portfolio');
    expect(hasRejects(v)).toBe(true);
  });
});

describe('unverified metrics', () => {
  it.each([
    'Reply rates went up 340%.',
    'We saw a 3x lift.',
    'It generated $50k in pipeline.',
    'Across 200 customers.',
  ])('flags %j for cutting', (text) => {
    const v = check(text);
    expect(v.map((x) => x.code)).toContain('unverified-metric');
    // Cut the sentence, do not kill the whole draft.
    expect(v.find((x) => x.code === 'unverified-metric')?.action).toBe('cut');
  });

  it('leaves the $39/mo price alone', () => {
    // Price is a real, stated product fact, not a performance claim.
    const v = check('The paid plan is $39/mo.');
    expect(v.filter((x) => x.code === 'unverified-metric')).toEqual([]);
  });
});

describe('founder-configured blocklists', () => {
  it('rejects a blocked topic', () => {
    const v = checkFacts({ text: 'A note on layoffs this week.', blockedTopics: ['layoffs'] });
    expect(v.map((x) => x.code)).toContain('blocked-topic');
  });

  it('rejects a blocked claim', () => {
    const v = checkFacts({
      text: 'We are the best-in-class outbound tool.',
      blockedClaims: ['best-in-class outbound'],
    });
    expect(v.map((x) => x.code)).toContain('blocked-claim');
  });
});
