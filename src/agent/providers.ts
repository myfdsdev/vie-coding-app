import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { mockResponse } from './mock-responses';

/**
 * Model providers behind one streaming interface: anthropic | gemini | mock.
 * The agent loop never imports an SDK directly.
 */

export type ProviderName = 'mock' | 'anthropic' | 'gemini';
export type ModelTier = 'code' | 'fast';

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ModelRequest {
  /** Byte-identical every turn (prompt.ts) — the cached prefix. */
  system: string;
  /** Per-turn context that follows the system prompt: project files, sorted by path. */
  context: string;
  /** Conversation history (append-only) ending with the new user message. */
  messages: ModelMessage[];
  tier?: ModelTier;
  signal?: AbortSignal;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type ModelEvent =
  | { type: 'text'; text: string }
  | { type: 'done'; model: string; stopReason: string; usage: ModelUsage };

export interface ModelProvider {
  readonly name: ProviderName;
  modelFor(tier: ModelTier): string;
  stream(req: ModelRequest): AsyncGenerator<ModelEvent>;
}

/** Explicit PROVIDER wins; otherwise use whichever key is configured; otherwise mock. */
export function resolveProviderName(): ProviderName {
  const explicit = process.env.PROVIDER?.trim().toLowerCase();
  if (explicit === 'mock' || explicit === 'anthropic' || explicit === 'gemini') return explicit;
  if (explicit) throw new Error(`Unknown PROVIDER "${explicit}". Use mock, anthropic or gemini.`);
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return 'mock';
}

/** Model id per provider and tier, without constructing an SDK client. */
export function modelName(name: ProviderName, tier: ModelTier): string {
  switch (name) {
    case 'anthropic':
      return tier === 'fast'
        ? process.env.ANTHROPIC_FAST_MODEL || 'claude-haiku-4-5'
        : process.env.ANTHROPIC_MODEL || 'claude-opus-5';
    case 'gemini':
      return tier === 'fast'
        ? process.env.GEMINI_FAST_MODEL || 'gemini-3.5-flash'
        : process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
    case 'mock':
      return 'mock';
  }
}

export function getProvider(name: ProviderName = resolveProviderName()): ModelProvider {
  switch (name) {
    case 'anthropic':
      return new AnthropicProvider();
    case 'gemini':
      return new GeminiProvider();
    case 'mock':
      return new MockProvider();
  }
}

// ---------------------------------------------------------------------------
// Anthropic (official SDK)
// ---------------------------------------------------------------------------

type TextDeltaLike = { type: string; delta?: { type: string; text?: string } };
type FinalMessageLike = {
  model: string;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
};
type StreamLike = AsyncIterable<TextDeltaLike> & { finalMessage(): Promise<FinalMessageLike> };

class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic' as const;
  private readonly client = new Anthropic();

  modelFor(tier: ModelTier): string {
    return modelName('anthropic', tier);
  }

  async *stream(req: ModelRequest): AsyncGenerator<ModelEvent> {
    const model = this.modelFor(req.tier ?? 'code');
    // Two cache breakpoints: the frozen system prompt, then the project files.
    const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }];
    if (req.context) system.push({ type: 'text', text: req.context, cache_control: { type: 'ephemeral' } });
    const params = { model, max_tokens: 64000, system, messages: req.messages };

    // Opus 5 / Fable: server-side refusal fallbacks (set ANTHROPIC_FALLBACKS=off to disable).
    const fallbacks = /^claude-(opus-5|fable)/.test(model) && process.env.ANTHROPIC_FALLBACKS !== 'off';
    const stream = (
      fallbacks
        ? this.client.beta.messages.stream(
            { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } as unknown as Parameters<
              typeof this.client.beta.messages.stream
            >[0],
            { signal: req.signal },
          )
        : this.client.messages.stream(params, { signal: req.signal })
    ) as unknown as StreamLike;

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        yield { type: 'text', text: event.delta.text };
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') throw new Error('The model declined this request.');
    yield {
      type: 'done',
      model: final.model,
      stopReason: final.stop_reason ?? 'end_turn',
      usage: {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
        cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Google Gemini (official @google/genai SDK)
// ---------------------------------------------------------------------------

/**
 * The human sentence inside a provider error. The Gemini SDK nests the API's
 * JSON error body inside another JSON envelope, which the chat would otherwise
 * show as an escaped blob.
 */
export function readableProviderError(raw: string): string {
  let message = raw;
  for (let depth = 0; depth < 4; depth++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      break;
    }
    const inner = (parsed as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof inner !== 'string') break;
    message = inner.trim();
  }
  return message;
}

class GeminiProvider implements ModelProvider {
  readonly name = 'gemini' as const;
  private readonly ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  modelFor(tier: ModelTier): string {
    return modelName('gemini', tier);
  }

  async *stream(req: ModelRequest): AsyncGenerator<ModelEvent> {
    const tier = req.tier ?? 'code';
    const model = this.modelFor(tier);
    try {
      // Gemini caches repeated prefixes implicitly; keep the same order as Anthropic.
      const response = await this.ai.models.generateContentStream({
        model,
        contents: req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        config: {
          systemInstruction: req.context ? `${req.system}\n\n${req.context}` : req.system,
          maxOutputTokens: 65536,
          abortSignal: req.signal,
        },
      });
      let usage:
        | { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number }
        | undefined;
      let stopReason = 'end_turn';
      for await (const chunk of response) {
        const text = chunk.text;
        if (text) yield { type: 'text', text };
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
        const finish = chunk.candidates?.[0]?.finishReason;
        if (finish) stopReason = String(finish).toLowerCase();
      }
      yield {
        type: 'done',
        model,
        stopReason,
        usage: {
          // Uncached input only, like Anthropic's input_tokens: Gemini's prompt count
          // includes the cached part, which cacheReadTokens already carries.
          inputTokens: Math.max(0, (usage?.promptTokenCount ?? 0) - (usage?.cachedContentTokenCount ?? 0)),
          // Gemini 3 models think before answering; thinking is billed as output.
          outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
          cacheReadTokens: usage?.cachedContentTokenCount ?? 0,
          cacheWriteTokens: 0,
        },
      };
    } catch (err) {
      if (req.signal?.aborted || !(err instanceof Error)) throw err;
      const setting = tier === 'fast' ? 'GEMINI_FAST_MODEL' : 'GEMINI_MODEL';
      const hint = (err as { status?: number }).status === 404 ? ` Set ${setting} in .env.local to a model your key can use.` : '';
      throw new Error(`Gemini (${model}): ${readableProviderError(err.message)}${hint}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Mock — canned <changes> output, streamed like a real model. No API key.
// ---------------------------------------------------------------------------

const estimateTokens = (text: string) => Math.ceil(text.length / 4);

class MockProvider implements ModelProvider {
  readonly name = 'mock' as const;

  modelFor(): string {
    return 'mock';
  }

  async *stream(req: ModelRequest): AsyncGenerator<ModelEvent> {
    const text = mockResponse(req);
    const chunkSize = Number(process.env.MOCK_CHUNK ?? 48);
    const delayMs = Number(process.env.MOCK_DELAY_MS ?? 8);
    for (let i = 0; i < text.length; i += chunkSize) {
      if (req.signal?.aborted) throw new Error('aborted');
      yield { type: 'text', text: text.slice(i, i + chunkSize) };
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
    const input = req.system + req.context + req.messages.map((m) => m.content).join('');
    yield {
      type: 'done',
      model: 'mock',
      stopReason: 'end_turn',
      usage: { inputTokens: estimateTokens(input), outputTokens: estimateTokens(text), cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}
