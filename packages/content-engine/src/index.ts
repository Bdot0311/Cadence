/**
 * @agent/content-engine
 *
 * Ideation → selection → drafting → slop gate → fact gate → CTA policy.
 *
 * The gates are the point. A killed draft is a better outcome than a mediocre
 * published one, so the pipeline gives up after MAX_GATE_LOOPS rather than
 * lowering the bar, and records exactly why for the dashboard.
 */
export {
  detectSlop,
  hasBlockingViolations,
  HOUSE_BANNED_WORDS,
} from './detectors.js';
export type { Violation, Severity } from './detectors.js';

export {
  checkFacts,
  hasRejects,
  PRODUCT_FACTS_PROMPT,
  LIVE_FEATURES,
} from './company-facts.js';
export type { FactViolation, FactCheckInput } from './company-facts.js';

export { ModelClient, costUsd, PRICING } from './model.js';
export type { ModelConfig, CallResult } from './model.js';

export {
  runSlopGate,
  formatViolationsForRetry,
  SLOP_GATE_PROMPT_VERSION,
} from './slop-gate.js';
export type { SlopGateResult } from './slop-gate.js';

export {
  draftWithGates,
  structureHash,
  MAX_GATE_LOOPS,
  DRAFTING_PROMPT_VERSION,
} from './pipeline.js';
export type {
  DraftRequest,
  DraftOutcome,
  VoiceProfile,
  CtaPolicy,
} from './pipeline.js';

export {
  scoreCandidate,
  selectCandidates,
  observedMix,
  adjustPillarMix,
  STRUCTURE_BLOCK_DAYS,
  TOPIC_OVERLAP_THRESHOLD,
} from './selection.js';
export type {
  Candidate,
  Pillar,
  RecentPost,
  ScoredCandidate,
} from './selection.js';
