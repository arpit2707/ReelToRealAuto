import { Injectable, Logger } from '@nestjs/common';

export type StoryIdea = {
  title: string;
  idea: string;
  imagePrompt: string;
  seedKeyword: string;
};

export type BusinessContext = {
  brandName: string;
  instagramHandle?: string | null;
  description?: string | null;
  persona?: unknown;
  products: Array<{ title: string; price: number; currency: string }>;
  recentTitles: string[];
  forDate: string;
};

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Thin REST client for the Gemini API (text ideas and 9:16 story images). */
@Injectable()
export class GeminiClient {
  private readonly logger = new Logger(GeminiClient.name);

  isConfigured(): boolean {
    return Boolean(process.env.GEMINI_API_KEY);
  }

  private textModel() {
    return process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
  }

  private imageModel() {
    return process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
  }

  async generateIdeas(ctx: BusinessContext, count = 4): Promise<StoryIdea[]> {
    const prompt = buildIdeasPrompt(ctx, count);
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.9,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              title: { type: 'STRING' },
              idea: { type: 'STRING' },
              imagePrompt: { type: 'STRING' },
              seedKeyword: { type: 'STRING' },
            },
            required: ['title', 'idea', 'imagePrompt', 'seedKeyword'],
          },
        },
      },
    };
    const json = await this.call(this.textModel(), body);
    const text = extractText(json);
    const ideas = parseIdeas(text);
    if (ideas.length < count) {
      throw new Error(`Gemini returned ${ideas.length} usable ideas, expected ${count}`);
    }
    return ideas.slice(0, count);
  }

  /** Returns raw image bytes (usually PNG) for a vertical story image. */
  async generateImage(prompt: string): Promise<Buffer> {
    const body = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                `${prompt}\n\nVertical 9:16 Instagram story, photorealistic or clean graphic style, ` +
                'no watermarks, leave the top and bottom 15% free of important detail.',
            },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: '9:16' },
      },
    };
    return extractImage(await this.call(this.imageModel(), body));
  }

  /** Asks Gemini to letter the keywords and hashtags onto an existing image. */
  async addTextToImage(image: Buffer, mimeType: string, headline: string, hashtags: string[]): Promise<Buffer> {
    const tags = hashtags.join(' ');
    const body = {
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: image.toString('base64') } },
            {
              text:
                'Edit this Instagram story image. Keep the scene exactly as it is. ' +
                `Add the headline "${headline}" in bold, highly legible lettering near the top, and the hashtags "${tags}" ` +
                'in a smaller line near the bottom, on a subtle translucent band so the text reads on any background. ' +
                'Spell every word exactly as given. Add no other text.',
            },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: '9:16' },
      },
    };
    return extractImage(await this.call(this.imageModel(), body));
  }

  private async call(model: string, body: unknown): Promise<any> {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY is not set');
    const res = await fetch(`${API_BASE}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 500);
      this.logger.error(`Gemini ${model} failed (${res.status}): ${detail}`);
      throw new Error(`Gemini ${model} failed with ${res.status}`);
    }
    return res.json();
  }
}

export function buildIdeasPrompt(ctx: BusinessContext, count: number): string {
  const products = ctx.products
    .slice(0, 10)
    .map((p) => `- ${p.title} (${p.currency} ${p.price})`)
    .join('\n');
  const persona = ctx.persona ? JSON.stringify(ctx.persona).slice(0, 800) : '';
  return [
    `You are a social media strategist for an Indian small business. Today is ${ctx.forDate}.`,
    `Write ${count} distinct Instagram story ideas for "${ctx.brandName}"` +
      (ctx.instagramHandle ? ` (@${ctx.instagramHandle})` : '') +
      '. Each must promote the business and feel timely (festivals, season, weekday, trends in India).',
    ctx.description ? `About the business: ${ctx.description}` : '',
    persona ? `Brand persona: ${persona}` : '',
    products ? `Products:\n${products}` : '',
    ctx.recentTitles.length ? `Avoid repeating these recent stories: ${ctx.recentTitles.join('; ')}` : '',
    'For each idea return:',
    '- title: at most 24 characters, used as the WhatsApp list label',
    '- idea: one or two sentences (max 200 characters) describing the story for the owner',
    '- imagePrompt: a detailed prompt for an image model to draw the story visual, with no text in the image',
    '- seedKeyword: a 1 to 3 word search phrase people would type to find this topic (English, lowercase)',
  ]
    .filter(Boolean)
    .join('\n');
}

export function extractText(json: any): string {
  const parts = json?.candidates?.[0]?.content?.parts || [];
  return parts
    .map((p: any) => p?.text || '')
    .join('')
    .trim();
}

export function parseIdeas(text: string): StoryIdea[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r: any) => ({
      title: String(r?.title || '')
        .trim()
        .slice(0, 24),
      idea: String(r?.idea || '')
        .trim()
        .slice(0, 300),
      imagePrompt: String(r?.imagePrompt || '').trim(),
      seedKeyword: String(r?.seedKeyword || '')
        .trim()
        .toLowerCase(),
    }))
    .filter((r) => r.title && r.idea && r.imagePrompt && r.seedKeyword);
}

export function extractImage(json: any): Buffer {
  const parts = json?.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    const data = p?.inlineData?.data || p?.inline_data?.data;
    if (data) return Buffer.from(data, 'base64');
  }
  const reason = json?.candidates?.[0]?.finishReason || json?.promptFeedback?.blockReason || 'no image part';
  throw new Error(`Gemini returned no image (${reason})`);
}
