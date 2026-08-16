import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

/**
 * Thin wrapper around the Anthropic SDK for this pipeline's needs.
 *
 * Sonnet 5 specifics that shape this file:
 *  - Adaptive thinking is ON by default. `max_tokens` caps thinking AND text
 *    together, so every call leaves headroom rather than sizing tightly to the
 *    expected answer.
 *  - `temperature` / `top_p` / `top_k` are REJECTED with a 400. Variation is
 *    steered by prompting, never by sampling params.
 *  - The tokenizer counts ~30% more tokens than Sonnet 4.6 for the same text,
 *    so cost figures logged to `agent_log` are not comparable to older runs.
 */

export interface ModelConfig {
  apiKey: string;
  model: string;
  /** low | medium | high | xhigh | max */
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface CallResult<T> {
  value: T;
  inputTokens: number;
  outputTokens: number;
  /** Populated when the model declined. Callers must check before using value. */
  refusal: { category: string | null; explanation: string | null } | null;
}

export class ModelClient {
  private readonly client: Anthropic;

  constructor(private readonly cfg: ModelConfig) {
    this.client = new Anthropic({ apiKey: cfg.apiKey });
  }

  /**
   * Structured call. The schema is enforced server-side via
   * `output_config.format`, so the response is valid JSON matching the shape
   * or the request fails — no regex extraction, no retry-on-parse loop.
   */
  async structured<T extends z.ZodTypeAny>(args: {
    schema: T;
    /** JSON Schema equivalent of `schema`, for output_config.format. */
    jsonSchema: Record<string, unknown>;
    system: string;
    user: string;
    maxTokens?: number;
    /** Overrides the configured effort for this call. */
    effort?: ModelConfig['effort'];
  }): Promise<CallResult<z.infer<T>>> {
    const response = await this.client.messages.create({
      model: this.cfg.model,
      // Generous: thinking and output share this budget on Sonnet 5.
      max_tokens: args.maxTokens ?? 16_000,
      system: args.system,
      output_config: {
        effort: args.effort ?? this.cfg.effort,
        format: { type: 'json_schema', schema: args.jsonSchema },
      },
      messages: [{ role: 'user', content: args.user }],
    } as Anthropic.MessageCreateParamsNonStreaming);

    if (response.stop_reason === 'refusal') {
      return {
        value: undefined as z.infer<T>,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        refusal: {
          category: response.stop_details?.category ?? null,
          explanation: response.stop_details?.explanation ?? null,
        },
      };
    }

    if (response.stop_reason === 'max_tokens') {
      throw new Error(
        'Model hit max_tokens before finishing. Raise maxTokens or lower effort — ' +
          'on Sonnet 5 thinking and output share the budget.',
      );
    }

    const text = response.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') {
      throw new Error('Model returned no text block.');
    }

    return {
      value: args.schema.parse(JSON.parse(text.text)) as z.infer<T>,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      refusal: null,
    };
  }

  /** Free-text call, for drafting where the output is a post body. */
  async text(args: {
    system: string;
    user: string;
    maxTokens?: number;
    effort?: ModelConfig['effort'];
  }): Promise<CallResult<string>> {
    const response = await this.client.messages.create({
      model: this.cfg.model,
      max_tokens: args.maxTokens ?? 16_000,
      system: args.system,
      output_config: { effort: args.effort ?? this.cfg.effort },
      messages: [{ role: 'user', content: args.user }],
    } as Anthropic.MessageCreateParamsNonStreaming);

    if (response.stop_reason === 'refusal') {
      return {
        value: '',
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        refusal: {
          category: response.stop_details?.category ?? null,
          explanation: response.stop_details?.explanation ?? null,
        },
      };
    }

    const text = response.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') {
      throw new Error('Model returned no text block.');
    }

    return {
      value: text.text.trim(),
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      refusal: null,
    };
  }
}

/**
 * Sonnet 5 pricing, $/MTok. Used for the cost figure written to `agent_log`.
 * Introductory rate runs through 2026-08-31; standard is 3.00 / 15.00.
 */
export const PRICING = { inputPerMTok: 2.0, outputPerMTok: 10.0 } as const;

export function costUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * PRICING.inputPerMTok +
    (outputTokens / 1_000_000) * PRICING.outputPerMTok
  );
}
