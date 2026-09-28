import { Injectable, Logger } from '@nestjs/common';
import type { AiProvider, ResolvedAi } from './ai-providers.types';

export type ImagePart = { data: Buffer; mimeType: string };

export type JsonRequest = {
  prompt: string;
  // Gemini-style schema (type: 'OBJECT' | 'ARRAY' | 'STRING' …); converted for the others.
  schema: unknown;
  images?: ImagePart[];
  temperature?: number;
};

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENAI_BASE = 'https://api.openai.com/v1';
const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';

/**
 * One interface over Gemini, OpenAI and Claude for structured JSON answers and
 * images. Which provider, key and model to use comes from AiProviderService.
 */
@Injectable()
export class LlmClient {
  private readonly logger = new Logger(LlmClient.name);

  async generateJson<T>(ai: ResolvedAi, req: JsonRequest): Promise<T> {
    switch (ai.provider) {
      case 'OPENAI':
        return this.openAiJson<T>(ai, req);
      case 'CLAUDE':
        return this.claudeJson<T>(ai, req);
      default:
        return this.geminiJson<T>(ai, req);
    }
  }

  /** A vertical 9:16 image. Claude cannot draw, so it is never resolved here. */
  async generateImage(ai: ResolvedAi, prompt: string): Promise<Buffer> {
    if (ai.provider === 'OPENAI') {
      const json = await this.request(ai.provider, ai.model, `${OPENAI_BASE}/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ai.apiKey}`,
        },
        body: JSON.stringify({
          model: ai.model,
          prompt,
          size: '1024x1536',
          n: 1,
        }),
      });
      return openAiImage(json);
    }
    if (ai.provider !== 'GEMINI') throw new Error(`${ai.provider} cannot generate images`);
    return extractGeminiImage(
      await this.gemini(ai, {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio: '9:16' },
        },
      }),
    );
  }

  /** Edits an existing image as the instruction says. */
  async editImage(ai: ResolvedAi, image: ImagePart, instruction: string): Promise<Buffer> {
    if (ai.provider === 'OPENAI') {
      const form = new FormData();
      form.append('model', ai.model);
      form.append('prompt', instruction);
      form.append('size', '1024x1536');
      form.append('image', new Blob([new Uint8Array(image.data)], { type: image.mimeType }), 'image.jpg');
      const json = await this.request(ai.provider, ai.model, `${OPENAI_BASE}/images/edits`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ai.apiKey}` },
        body: form,
      });
      return openAiImage(json);
    }
    if (ai.provider !== 'GEMINI') throw new Error(`${ai.provider} cannot edit images`);
    return extractGeminiImage(
      await this.gemini(ai, {
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: image.mimeType,
                  data: image.data.toString('base64'),
                },
              },
              { text: instruction },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio: '9:16' },
        },
      }),
    );
  }

  /** Checks a key by listing the provider's models (costs nothing). */
  async testKey(provider: AiProvider, apiKey: string): Promise<{ ok: boolean; error?: string }> {
    const url =
      provider === 'OPENAI'
        ? `${OPENAI_BASE}/models`
        : provider === 'CLAUDE'
          ? `${ANTHROPIC_BASE}/models`
          : `${GEMINI_BASE}?pageSize=1`;
    const headers: Record<string, string> =
      provider === 'OPENAI'
        ? { Authorization: `Bearer ${apiKey}` }
        : provider === 'CLAUDE'
          ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
          : { 'x-goog-api-key': apiKey };
    try {
      const res = await fetch(url, { headers });
      if (res.ok) return { ok: true };
      return {
        ok: false,
        error: res.status === 401 || res.status === 403 ? 'Key rejected' : `HTTP ${res.status}`,
      };
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Network error' };
    }
  }

  private async geminiJson<T>(ai: ResolvedAi, req: JsonRequest): Promise<T> {
    const parts: unknown[] = [{ text: req.prompt }];
    for (const img of req.images || []) {
      parts.push({
        inline_data: {
          mime_type: img.mimeType,
          data: img.data.toString('base64'),
        },
      });
    }
    const json = await this.gemini(
      ai,
      {
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: req.temperature ?? 0.2,
          responseMimeType: 'application/json',
          responseSchema: req.schema,
        },
      },
      true,
    );
    return JSON.parse(extractGeminiText(json)) as T;
  }

  private async openAiJson<T>(ai: ResolvedAi, req: JsonRequest): Promise<T> {
    const { schema, wrapped } = objectSchema(req.schema);
    const content: unknown[] = [{ type: 'text', text: req.prompt }];
    for (const img of req.images || []) {
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:${img.mimeType};base64,${img.data.toString('base64')}`,
        },
      });
    }
    // Temperature is left out: the reasoning models only accept the default.
    const json = await this.request(ai.provider, ai.model, `${OPENAI_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ai.apiKey}`,
      },
      body: JSON.stringify({
        model: ai.model,
        messages: [{ role: 'user', content }],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'result', schema, strict: false },
        },
      }),
    });
    const text = json?.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(stripFence(text));
    return (wrapped ? parsed?.result : parsed) as T;
  }

  private async claudeJson<T>(ai: ResolvedAi, req: JsonRequest): Promise<T> {
    const { schema, wrapped } = objectSchema(req.schema);
    const content: unknown[] = [];
    for (const img of req.images || []) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mimeType,
          data: img.data.toString('base64'),
        },
      });
    }
    content.push({ type: 'text', text: req.prompt });
    // A forced tool call is how Claude returns JSON that follows a schema.
    const json = await this.request(ai.provider, ai.model, `${ANTHROPIC_BASE}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ai.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ai.model,
        max_tokens: 8192,
        temperature: Math.min(req.temperature ?? 0.2, 1),
        tools: [
          {
            name: 'respond',
            description: 'Return the answer.',
            input_schema: schema,
          },
        ],
        tool_choice: { type: 'tool', name: 'respond' },
        messages: [{ role: 'user', content }],
      }),
    });
    const block = (json?.content || []).find((b: any) => b?.type === 'tool_use');
    if (!block) throw new Error('Claude returned no structured answer');
    return (wrapped ? block.input?.result : block.input) as T;
  }

  private async gemini(ai: ResolvedAi, body: unknown, text = false): Promise<any> {
    const call = (model: string) =>
      this.request(ai.provider, model, `${GEMINI_BASE}/${model}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': ai.apiKey,
        },
        body: JSON.stringify(body),
      });
    try {
      return await call(ai.model);
    } catch (err) {
      // A busy text model can stay busy for minutes; a sibling model usually
      // has room, so the day's ideas still go out.
      const fallback = process.env.GEMINI_TEXT_FALLBACK_MODEL || 'gemini-3.6-flash';
      if (!(err instanceof AiBusyError) || !text || fallback === ai.model) throw err;
      this.logger.warn(`Gemini ${ai.model} still busy, switching to ${fallback}`);
      return call(fallback);
    }
  }

  private async request(provider: string, model: string, url: string, init: RequestInit): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, init);
      if (res.ok) return res.json();
      const detail = (await res.text()).slice(0, 500);
      // Providers answer 503 "high demand" and 429 rate limits in bursts that
      // clear within seconds, so a short wait saves the whole daily run.
      const wait = RETRY_DELAYS_MS[attempt];
      if (RETRY_STATUSES.has(res.status) && wait !== undefined) {
        this.logger.warn(`${provider} ${model} busy (${res.status}), retrying in ${wait / 1000}s`);
        await this.sleep(wait);
        continue;
      }
      this.logger.error(`${provider} ${model} failed (${res.status}): ${detail}`);
      if (RETRY_STATUSES.has(res.status)) throw new AiBusyError(provider, model, res.status);
      throw new Error(`${provider} ${model} failed with ${res.status}`);
    }
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

class AiBusyError extends Error {
  constructor(provider: string, model: string, status: number) {
    super(`${provider} ${model} failed with ${status}`);
  }
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

/** Gemini's schema dialect as JSON Schema. */
export function toJsonSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  const out: any = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'type' && typeof v === 'string') out.type = v.toLowerCase();
    else if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, toJsonSchema(s)]));
    } else if (k === 'items') out.items = toJsonSchema(v);
    else out[k] = v;
  }
  return out;
}

/** OpenAI and Claude want an object at the top, so arrays are wrapped in { result }. */
export function objectSchema(schema: unknown): {
  schema: any;
  wrapped: boolean;
} {
  const json = toJsonSchema(schema);
  if (json?.type === 'object') return { schema: json, wrapped: false };
  return {
    schema: {
      type: 'object',
      properties: { result: json },
      required: ['result'],
    },
    wrapped: true,
  };
}

export function extractGeminiText(json: any): string {
  const parts = json?.candidates?.[0]?.content?.parts || [];
  return parts
    .map((p: any) => p?.text || '')
    .join('')
    .trim();
}

export function extractGeminiImage(json: any): Buffer {
  const parts = json?.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    const data = p?.inlineData?.data || p?.inline_data?.data;
    if (data) return Buffer.from(data, 'base64');
  }
  const reason = json?.candidates?.[0]?.finishReason || json?.promptFeedback?.blockReason || 'no image part';
  throw new Error(`Gemini returned no image (${reason})`);
}

function openAiImage(json: any): Buffer {
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI returned no image');
  return Buffer.from(b64, 'base64');
}

function stripFence(text: string): string {
  return text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
}
