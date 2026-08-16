import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  costUsd,
  draftWithGates,
  selectCandidates,
  type Candidate,
  type CtaPolicy,
  type ModelClient,
  type Pillar,
  type RecentPost,
  type VoiceProfile,
} from '@agent/content-engine';
import type { SupabaseClient } from '@supabase/supabase-js';

const Ideas = z.object({
  ideas: z.array(z.object({
    angle: z.string().min(20).max(500),
    pillarId: z.string().uuid(),
    sourcePostIndexes: z.array(z.number().int().min(1).max(20)).min(1).max(3),
  })).min(3).max(9),
});

const IDEAS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    ideas: {
      type: 'array', minItems: 3, maxItems: 9,
      items: {
        type: 'object',
        properties: {
          angle: { type: 'string', minLength: 20, maxLength: 500 },
          pillarId: { type: 'string', format: 'uuid' },
          sourcePostIndexes: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'integer', minimum: 1, maximum: 20 } },
        },
        required: ['angle', 'pillarId', 'sourcePostIndexes'],
        additionalProperties: false,
      },
    },
  },
  required: ['ideas'],
  additionalProperties: false,
} as const;

export interface IdeationResult {
  accounts: number;
  generated: number;
  killed: number;
  skipped: number;
  costUsd: number;
}

export async function runIdeation(args: {
  db: SupabaseClient;
  model: ModelClient;
  now: Date;
  queueTarget: number;
}): Promise<IdeationResult> {
  const result: IdeationResult = { accounts: 0, generated: 0, killed: 0, skipped: 0, costUsd: 0 };
  const { data: accounts, error } = await args.db.from('accounts').select([
    'id,display_name,active',
    'agent_config(autonomy_mode,cta_policy,blocked_topics,blocked_claims,kill_switch_engaged)',
    'content_pillars(id,name,description,target_share,active)',
    'voice_profiles(id,profile,source_posts,active,version)',
  ].join(',')).eq('active', true);
  throwIf(error);

  const accountRows = (accounts ?? []) as unknown as Array<Record<string, any>>;
  for (const row of accountRows) {
    result.accounts++;
    const config = first(row.agent_config) as Record<string, unknown> | null;
    const pillars = (row.content_pillars ?? []).filter((pillar: any) => pillar.active === true);
    const voice = (row.voice_profiles ?? []).find((profile: any) => profile.active === true);
    if (config?.['kill_switch_engaged'] === true || !voice || pillars.length === 0) {
      result.skipped++;
      await log(args.db, row.id, 'warn', 'ideation-skipped', 'Voice profile, active pillars, and a disengaged kill switch are required.');
      continue;
    }

    const { count, error: countError } = await args.db.from('post_queue')
      .select('id', { count: 'exact', head: true }).eq('account_id', row.id)
      .in('state', ['draft', 'approved', 'scheduled']);
    throwIf(countError);
    const needed = Math.max(0, args.queueTarget - (count ?? 0));
    if (needed === 0) { result.skipped++; continue; }

    const sourcePosts: string[] = Array.isArray(voice.source_posts)
      ? voice.source_posts.filter((post: unknown): post is string => typeof post === 'string' && post.trim().length >= 40).slice(0, 20)
      : [];
    if (sourcePosts.length < 10) {
      result.skipped++;
      await log(args.db, row.id, 'warn', 'ideation-skipped', `Only ${sourcePosts.length} usable source posts are saved; 10 are required.`);
      continue;
    }

    const pillarInputs: Pillar[] = pillars.map((pillar: any) => ({ id: pillar.id, name: pillar.name, targetShare: Number(pillar.target_share) }));
    const recent = await recentPosts(args.db, row.id, args.now);
    const ideaCall = await args.model.structured({
      schema: Ideas,
      jsonSchema: IDEAS_JSON_SCHEMA as unknown as Record<string, unknown>,
      effort: 'medium',
      maxTokens: 8_000,
      system: [
        'You are an editorial strategist generating grounded LinkedIn post angles for one founder.',
        'Return distinct ideas, not drafts. Every idea must be supported by the numbered source posts.',
        'Use only the exact pillar IDs provided. Avoid generic advice, invented facts, metrics, or events.',
        'Prefer a concrete tension, decision, lesson, observation, or contrarian operating principle.',
      ].join('\n'),
      user: [
        `Generate ${Math.min(9, Math.max(3, needed * 3))} candidate angles.`,
        '',
        'PILLARS:',
        ...pillars.map((pillar: any) => `${pillar.id} | ${pillar.name} | ${pillar.description}`),
        '',
        'NUMBERED SOURCE POSTS:',
        ...sourcePosts.map((post, index) => `[${index + 1}] ${post.slice(0, 1800)}`),
      ].join('\n'),
    });
    result.costUsd += costUsd(ideaCall.inputTokens, ideaCall.outputTokens);
    if (ideaCall.refusal) {
      result.skipped++;
      await log(args.db, row.id, 'warn', 'ideation-refused', ideaCall.refusal.explanation ?? 'The model declined ideation.');
      continue;
    }

    const ideas = ideaCall.value.ideas.map((idea): Candidate => ({
      id: randomUUID(), angle: idea.angle, pillarId: idea.pillarId,
      topicTokens: topicTokens(idea.angle), structureHash: null,
    }));
    const selected = selectCandidates({ candidates: ideas, pillars: pillarInputs, recent, now: args.now, take: needed }).selected;

    for (const pick of selected) {
      const rawIdea = ideaCall.value.ideas.find((idea) => idea.angle === pick.candidate.angle && idea.pillarId === pick.candidate.pillarId);
      const pillar = pillars.find((candidate: any) => candidate.id === pick.candidate.pillarId);
      if (!rawIdea || !pillar) continue;
      const groundedPosts = rawIdea.sourcePostIndexes.flatMap((index) => sourcePosts[index - 1] ? [sourcePosts[index - 1] as string] : []);
      const draft = await draftWithGates({
        model: args.model,
        request: {
          angle: pick.candidate.angle,
          pillarName: pillar.name,
          pillarDescription: pillar.description,
          voiceProfile: toVoiceProfile(voice.profile),
          ctaPolicy: toCtaPolicy(config?.['cta_policy']),
          blockedTopics: stringArray(config?.['blocked_topics']),
          blockedClaims: stringArray(config?.['blocked_claims']),
          sourceContext: groundedPosts.join('\n\n---\n\n'),
        },
      });
      result.costUsd += costUsd(draft.usage.inputTokens, draft.usage.outputTokens);

      if (draft.status === 'killed') {
        result.killed++;
        const { error: insertError } = await args.db.from('post_queue').insert({
          account_id: row.id, pillar_id: pillar.id, body: draft.lastDraft || pick.candidate.angle,
          state: 'killed', kill_reason: draft.reason,
          gate_violations: { slop: draft.violations, facts: draft.factViolations },
          prompt_version: draft.promptVersion, voice_profile_id: voice.id,
          generation_params: { source: 'automatic-ideation', angle: pick.candidate.angle, loops: draft.loops },
        });
        throwIf(insertError);
        await log(args.db, row.id, 'warn', 'draft-killed', draft.reason);
        continue;
      }

      const { count: duplicate, error: duplicateError } = await args.db.from('post_queue')
        .select('id', { count: 'exact', head: true }).eq('account_id', row.id)
        .eq('structure_hash', draft.structureHash)
        .gte('created_at', new Date(args.now.getTime() - 10 * 86_400_000).toISOString());
      throwIf(duplicateError);
      if ((duplicate ?? 0) > 0) {
        result.killed++;
        await log(args.db, row.id, 'warn', 'draft-killed', 'Generated draft repeated a structure used in the last 10 days.');
        continue;
      }

      const state = config?.['autonomy_mode'] === 'autonomous' ? 'approved' : 'draft';
      const { data: inserted, error: insertError } = await args.db.from('post_queue').insert({
        account_id: row.id, pillar_id: pillar.id, body: draft.body, state,
        prompt_version: draft.promptVersion, voice_profile_id: voice.id,
        structure_hash: draft.structureHash,
        generation_params: {
          source: 'automatic-ideation', angle: pick.candidate.angle, selection_rationale: pick.rationale,
          loops: draft.loops, input_tokens: draft.usage.inputTokens, output_tokens: draft.usage.outputTokens,
        },
      }).select('id').single();
      throwIf(insertError);
      result.generated++;
      await log(args.db, row.id, 'info', state === 'draft' ? 'draft-awaiting-approval' : 'draft-approved', `${pick.rationale} Generated in ${draft.loops} gate loop(s).`, inserted?.id);
    }
  }
  return { ...result, costUsd: Number(result.costUsd.toFixed(4)) };
}

async function recentPosts(db: SupabaseClient, accountId: string, now: Date): Promise<RecentPost[]> {
  const since = new Date(now.getTime() - 10 * 86_400_000).toISOString();
  const { data, error } = await db.from('post_queue').select('pillar_id,published_at,created_at,body,structure_hash')
    .eq('account_id', accountId).gte('created_at', since).not('pillar_id', 'is', null);
  throwIf(error);
  return (data ?? []).map((post) => ({
    pillarId: post.pillar_id,
    publishedAt: new Date(post.published_at ?? post.created_at),
    topicTokens: topicTokens(post.body), structureHash: post.structure_hash ?? null,
  }));
}

function toVoiceProfile(value: unknown): VoiceProfile {
  const profile = object(value);
  const sentence = object(profile['sentence_length']);
  const vocabulary = object(profile['vocabulary']);
  const lineBreaks = object(profile['line_break_style']);
  return {
    sentenceLength: { mean: number(sentence['mean'], 14), stddev: number(sentence['stddev'], 6) },
    openerPatterns: stringArray(profile['opener_patterns']).slice(0, 10),
    vocabulary: { favored: stringArray(vocabulary['favored']).slice(0, 30), avoided: stringArray(vocabulary['avoided']).slice(0, 30) },
    structuralHabits: stringArray(profile['structural_habits']),
    lineBreakStyle: `Approximately ${number(lineBreaks['average_lines'], 8)} lines per post; preserve the source posts' paragraph rhythm.`,
  };
}

function toCtaPolicy(value: unknown): CtaPolicy {
  const policy = object(value);
  return {
    mechanic: typeof policy['mechanic'] === 'string' ? policy['mechanic'] : 'none',
    productNameInBody: policy['product_name_in_body'] === true,
    destination: typeof policy['destination'] === 'string' ? policy['destination'] : 'none',
  };
}

function topicTokens(value: string): string[] {
  const stop = new Set(['about','after','again','also','because','been','before','being','between','could','every','from','have','into','more','most','only','other','over','should','some','than','that','their','there','these','they','this','those','through','under','very','what','when','where','which','while','with','would','your']);
  return [...new Set((value.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []).filter((token) => !stop.has(token)))].slice(0, 24);
}

function first(value: unknown): unknown { return Array.isArray(value) ? value[0] ?? null : value; }
function object(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function number(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
function throwIf(error: { message: string } | null): void { if (error) throw new Error(error.message); }
async function log(db: SupabaseClient, accountId: string, level: string, decision: string, rationale: string, postId?: string): Promise<void> {
  const { error } = await db.from('agent_log').insert({ account_id: accountId, stage: 'ideation', level, decision, rationale, post_id: postId ?? null });
  throwIf(error);
}
