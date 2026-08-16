/**
 * Product facts from `company-context`, in a form the fact gate can enforce.
 *
 * These are not suggestions to a model. Where a rule can be checked
 * deterministically it is, because "the model usually respects the system
 * prompt" is not a control for a claim that a customer will read.
 *
 * Keep this file in sync with .claude/skills/company-context/SKILL.md by hand.
 * It is deliberately a hardcoded module rather than a database table: these
 * facts changing is a code review, not a config edit.
 */

export interface FactViolation {
  code: string;
  message: string;
  evidence: string;
  /** cut = delete the sentence. reject = kill the whole draft. */
  action: 'cut' | 'reject';
}

/**
 * Outreign is email outbound only. Any implication of calling, dialing, or
 * voice is a hard reject rather than a rewrite — the spec calls this a hard
 * rule and softening it would still ship a false product claim.
 */
const CALL_CLAIMS =
  /\b(cold[- ]?call|dialer|dialing|dial\b|phone (call|outreach)|voice (agent|ai|call)|call (script|sequence|cadence)|power dialer|ringless|voicemail)\b/gi;

/** Features that exist. Describe as shipped. */
export const LIVE_FEATURES = [
  'ICP discovery',
  'AI lead scoring',
  'AI email generation',
  'sequences',
  'workflow builder',
  'pipeline analytics',
  'Gmail CRM sync',
  'AI SDR agent',
] as const;

/** Features that do NOT exist. Claiming any as live is a reject. */
const UNBUILT_FEATURES: Array<{ name: string; re: RegExp }> = [
  { name: 'ICP Builder', re: /\bICP Builder\b/gi },
  { name: 'Unified Inbox', re: /\bUnified Inbox\b/gi },
  { name: 'Deliverability Dashboard', re: /\bDeliverability Dashboard\b/gi },
  { name: 'Signal Lead Queue', re: /\bSignal Lead Queue\b/gi },
  { name: 'Email Quality Checker', re: /\bEmail Quality Checker\b/gi },
];

/** CRM integrations that are "shipping soon", not live. */
const UNSHIPPED_CRM =
  /\b(hubspot|salesforce)\b(?![^.!?]*\b(soon|coming|shipping|roadmap|next)\b)/gi;

/**
 * Never name the underlying lead-data provider. Public phrasing is always
 * "verified contacts from public records and licensed data partnerships" and
 * "live intent signals".
 *
 * Names live here so the gate can catch a leak. Add to this list if the vendor
 * set changes; do not remove the mechanism.
 */
const LEAD_DATA_PROVIDERS =
  /\b(apollo\.?io|apollo\b|zoominfo|clearbit|lusha|cognism|seamless\.?ai|rocketreach|people ?data ?labs|pdl\b|hunter\.io)\b/gi;

/** Businesses that are not part of the portfolio and appear in no draft. */
const OUT_OF_PORTFOLIO =
  /\b(dreamscape events|dreamscape|kora ai\b|flower wall|credit memo|commodity trading)\b/gi;

/**
 * Fabricated metrics. Any percentage, multiplier, or count presented as a
 * result is flagged for verification — the founder's rule is that a number
 * that isn't real doesn't ship.
 */
/**
 * No leading \b on this alternation. A word boundary cannot exist between a
 * space and a `$` (both non-word), so anchoring the group would silently kill
 * the currency branch — each alternative carries its own boundary instead.
 *
 * Prices are excluded via lookahead: "$39/mo" is a stated product fact, not a
 * performance claim.
 */
const METRIC_CLAIM =
  /(\b\d+(?:\.\d+)?\s?%|\b\d+x\b|\$\d[\d,.]*(?:k|m|mm)?\b(?!\s?\/\s?(mo|month|yr|year))|\b\d{2,}\s+(customers|users|companies|replies|meetings|leads)\b)/gi;

export interface FactCheckInput {
  text: string;
  /** From agent_config.blocked_claims — founder-defined, checked verbatim. */
  blockedClaims?: string[];
  /** From agent_config.blocked_topics. */
  blockedTopics?: string[];
}

export function checkFacts(input: FactCheckInput): FactViolation[] {
  const { text } = input;
  const out: FactViolation[] = [];

  for (const m of text.matchAll(CALL_CLAIMS)) {
    out.push({
      code: 'outreign-is-email-only',
      message:
        'Implies Outreign does calls, dialing, or voice. Outreign is email outbound only — hard rule, no exceptions.',
      evidence: m[0],
      action: 'reject',
    });
  }

  for (const f of UNBUILT_FEATURES) {
    for (const m of text.matchAll(f.re)) {
      out.push({
        code: 'unbuilt-feature',
        message: `"${f.name}" is not built. It cannot be described as live.`,
        evidence: m[0],
        action: 'reject',
      });
    }
  }

  for (const m of text.matchAll(UNSHIPPED_CRM)) {
    out.push({
      code: 'unshipped-crm',
      message: `${m[0]} sync is "shipping soon", not live. Gmail is the only live CRM sync.`,
      evidence: m[0],
      action: 'cut',
    });
  }

  for (const m of text.matchAll(LEAD_DATA_PROVIDERS)) {
    out.push({
      code: 'lead-provider-named',
      message:
        'Names the underlying lead-data provider. Always describe it as "verified contacts from public records and licensed data partnerships" and "live intent signals".',
      evidence: m[0],
      action: 'reject',
    });
  }

  for (const m of text.matchAll(OUT_OF_PORTFOLIO)) {
    out.push({
      code: 'out-of-portfolio',
      message: `"${m[0]}" is not part of the portfolio and appears in no draft.`,
      evidence: m[0],
      action: 'reject',
    });
  }

  for (const m of text.matchAll(METRIC_CLAIM)) {
    out.push({
      code: 'unverified-metric',
      message:
        'Numeric claim. Cut it unless it is verifiable from a real source — fabricated metrics never ship.',
      evidence: m[0],
      action: 'cut',
    });
  }

  for (const claim of input.blockedClaims ?? []) {
    if (!claim.trim()) continue;
    const re = new RegExp(escapeRe(claim), 'gi');
    for (const m of text.matchAll(re)) {
      out.push({
        code: 'blocked-claim',
        message: `Matches a founder-configured blocked claim: "${claim}".`,
        evidence: m[0],
        action: 'reject',
      });
    }
  }

  for (const topic of input.blockedTopics ?? []) {
    if (!topic.trim()) continue;
    const re = new RegExp(`\\b${escapeRe(topic)}\\b`, 'gi');
    for (const m of text.matchAll(re)) {
      out.push({
        code: 'blocked-topic',
        message: `Matches a founder-configured blocked topic: "${topic}".`,
        evidence: m[0],
        action: 'reject',
      });
    }
  }

  return out;
}

export function hasRejects(v: FactViolation[]): boolean {
  return v.some((x) => x.action === 'reject');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The product-facts block injected into every generation system prompt. Keeps
 * the model from producing violations the gate would then have to catch.
 */
export const PRODUCT_FACTS_PROMPT = `
Product facts. These are absolute. Never contradict them.

- Outreign (outreign.io) is an AI-powered B2B cold email outbound platform.
  It is EMAIL OUTBOUND ONLY. It does not do calls, dialing, or voice, and never will.
  Never describe or imply otherwise.
- Live and shippable today: ICP discovery, AI lead scoring, AI email generation,
  sequences, workflow builder, pipeline analytics, Gmail CRM sync, and the AI SDR
  agent (Gmail monitoring, reply classification, objection handling, Calendly
  booking). The AI SDR agent is LIVE — describe it as shipped, never as planned.
- NOT built. Never describe as live: ICP Builder, Unified Inbox, Deliverability
  Dashboard, Signal Lead Queue, Email Quality Checker.
- CRM sync: Gmail is live. HubSpot and Salesforce are "shipping soon".
- Pricing: free plan plus a $39/mo paid plan.
- Positioning: "reply-engineered outbound", signal-first.
- Parent company: BDØT Industries LLC, New York.

Lead data. Never name the underlying provider, in any copy, ever. Always describe
it as "verified contacts from public records and licensed data partnerships" and
"live intent signals".

Never mention: DreamScape Events NY, Kora AI, or any credit-analysis work. None
of these are part of the portfolio.

No fabricated metrics, testimonials, or claims. If a number is not real, use no
number. An unverifiable claim gets cut, not softened.
`.trim();
