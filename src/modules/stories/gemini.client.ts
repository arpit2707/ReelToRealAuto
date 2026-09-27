import { Injectable, Logger } from '@nestjs/common';

export type StoryIdea = {
  title: string;
  label: string;
  idea: string;
  caption: string;
  imagePrompt: string;
  seedKeyword: string;
  // Catalog item the idea promotes, when it promotes one.
  offeringId?: string | null;
};

export type OwnPhotoDetails = {
  title: string;
  caption: string;
  seedKeyword: string;
  offeringId: string | null;
};

export type BusinessContext = {
  brandName: string;
  instagramHandle?: string | null;
  description?: string | null;
  industry?: string | null;
  persona?: unknown;
  products: Array<{ id?: string; title: string; price: number; currency: string }>;
  recentTitles: string[];
  forDate: string;
  // Today's researched keywords; each idea should target one of them.
  trendKeywords?: string[];
};

export type NicheContext = {
  industry?: string | null;
  description?: string | null;
  seeds: string[];
  trendingHashtags: string[];
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
              label: { type: 'STRING' },
              idea: { type: 'STRING' },
              caption: { type: 'STRING' },
              imagePrompt: { type: 'STRING' },
              seedKeyword: { type: 'STRING' },
              offeringId: { type: 'STRING' },
            },
            required: ['title', 'label', 'idea', 'caption', 'imagePrompt', 'seedKeyword'],
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

  /**
   * Ranks what people in this niche are searching and posting about today.
   * Apify's trending hashtags are the evidence; Gemini turns them (plus the
   * niche) into search phrases, and works from the niche alone if Apify had none.
   */
  async trendKeywords(ctx: NicheContext, count = 10): Promise<string[]> {
    const prompt = [
      `You research Instagram and Google search trends for small Indian businesses. Today is ${ctx.forDate}.`,
      ctx.industry ? `Industry: ${ctx.industry}` : '',
      ctx.description ? `Business: ${ctx.description}` : '',
      ctx.seeds.length ? `Niche terms: ${ctx.seeds.join(', ')}` : '',
      ctx.trendingHashtags.length
        ? `Hashtags trending on Instagram posts in this niche right now: ${ctx.trendingHashtags.join(' ')}`
        : '',
      `Return the ${count} keyword phrases this business should post about today, most promising first.`,
      'Favour what is trending now (season, wedding dates, festivals, the hashtags above) over evergreen terms.',
      'Each phrase: 1 to 4 words, lowercase, in the words Indian customers actually search (English or Hinglish).',
    ]
      .filter(Boolean)
      .join('\n');
    const phrases = await this.generateJson<string[]>(prompt, {
      type: 'ARRAY',
      items: { type: 'STRING' },
    });
    return [...new Set((Array.isArray(phrases) ? phrases : []).map((p) => String(p).trim().toLowerCase()))]
      .filter((p) => p && p.length <= 60)
      .slice(0, count);
  }

  /**
   * Structured JSON answer from the text model, optionally looking at one
   * image. Used for tagging posts with catalog items.
   */
  async generateJson<T>(
    prompt: string,
    responseSchema: unknown,
    image?: { data: Buffer; mimeType: string },
  ): Promise<T> {
    const parts: unknown[] = [{ text: prompt }];
    if (image) parts.push({ inline_data: { mime_type: image.mimeType, data: image.data.toString('base64') } });
    const json = await this.call(this.textModel(), {
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json', responseSchema },
    });
    return JSON.parse(extractText(json)) as T;
  }

  /**
   * Headline, caption and keyword for a photo the seller sent themselves, and
   * which catalog item it shows. A caption the seller wrote is kept as is.
   */
  async describeOwnPhoto(
    image: { data: Buffer; mimeType: string },
    ctx: {
      brandName: string;
      description?: string | null;
      products: Array<{ id: string; title: string }>;
      sellerCaption?: string | null;
    },
  ): Promise<OwnPhotoDetails> {
    const prompt = [
      `You write Instagram posts for "${ctx.brandName}", an Indian small business.`,
      ctx.description ? `About the business: ${ctx.description}` : '',
      ctx.products.length
        ? `Catalog (id | title):\n${ctx.products
            .slice(0, 40)
            .map((p) => `- ${p.id} | ${p.title}`)
            .join('\n')}`
        : '',
      ctx.sellerCaption ? `The owner's caption for this photo: ${ctx.sellerCaption.slice(0, 500)}` : '',
      'Look at the attached photo and return:',
      '- title: at most 24 characters naming what the post is about',
      ctx.sellerCaption
        ? '- caption: repeat the owner caption exactly'
        : '- caption: 1 to 3 short lines in a warm Hinglish brand voice with a call to action, no hashtags, no prices',
      '- seedKeyword: the search phrase customers would use for this (lowercase, 1 to 4 words)',
      '- offeringId: the catalog id the photo clearly shows, or an empty string',
    ]
      .filter(Boolean)
      .join('\n');
    const r = await this.generateJson<Partial<OwnPhotoDetails>>(
      prompt,
      {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          caption: { type: 'STRING' },
          seedKeyword: { type: 'STRING' },
          offeringId: { type: 'STRING' },
        },
        required: ['title', 'caption', 'seedKeyword'],
      },
      image,
    );
    const ids = new Set(ctx.products.map((p) => p.id));
    return {
      title: String(r?.title || '').trim().slice(0, 24),
      caption: (ctx.sellerCaption || String(r?.caption || '')).trim().slice(0, 1000),
      seedKeyword: String(r?.seedKeyword || '').trim().toLowerCase().slice(0, 60),
      offeringId: r?.offeringId && ids.has(r.offeringId) ? r.offeringId : null,
    };
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

  /** Applies the merchant's WhatsApp instruction ("background golden karo") to a draft. */
  async editImage(image: Buffer, mimeType: string, instruction: string): Promise<Buffer> {
    const body = {
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: image.toString('base64') } },
            {
              text:
                'Edit this Instagram image as the business owner asks, and change nothing else. ' +
                'The request may be in Hindi, Hinglish or English. Keep it photorealistic, add no text or watermark ' +
                'unless the request asks for text.\n' +
                `Request: ${instruction.slice(0, 500)}`,
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
    .map((p) => `- ${p.id ? `${p.id} | ` : ''}${p.title} (${p.currency} ${p.price})`)
    .join('\n');
  const persona = ctx.persona ? JSON.stringify(ctx.persona).slice(0, 800) : '';
  const trends = (ctx.trendKeywords || []).slice(0, 10);
  return [
    `You are a social media strategist for an Indian small business. Today is ${ctx.forDate}.`,
    `Write ${count} distinct Instagram post ideas for "${ctx.brandName}"` +
      (ctx.instagramHandle ? ` (@${ctx.instagramHandle})` : '') +
      '. Each must promote the business and feel timely (festivals, season, weekday, trends in India).',
    ctx.industry ? `Industry: ${ctx.industry}` : '',
    ctx.description ? `About the business: ${ctx.description}` : '',
    persona ? `Brand persona: ${persona}` : '',
    products ? `Products${ctx.products.some((p) => p.id) ? ' (id | title)' : ''}:\n${products}` : '',
    trends.length
      ? `Trending keywords in this niche today, best first: ${trends.join('; ')}. Build each idea around a different one.`
      : '',
    ctx.recentTitles.length ? `Avoid repeating these recent posts: ${ctx.recentTitles.join('; ')}` : '',
    'For each idea return:',
    '- title: at most 24 characters, the headline lettered on the image',
    '- label: at most 30 characters naming why it is suggested, e.g. "Trending: hd bridal base"',
    '- idea: one or two sentences (max 200 characters) describing the post for the owner',
    '- caption: the Instagram/Facebook caption, 1 to 3 short lines in the brand voice with a call to action, no hashtags',
    '- imagePrompt: a detailed prompt for an image model to draw the visual, with no text in the image',
    '- seedKeyword: the trending keyword this idea targets (lowercase, 1 to 4 words)',
    ctx.products.some((p) => p.id)
      ? '- offeringId: the id of the product the idea promotes, or an empty string when it promotes none'
      : '',
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
      label: String(r?.label || '')
        .trim()
        .slice(0, 30),
      idea: String(r?.idea || '')
        .trim()
        .slice(0, 300),
      caption: String(r?.caption || '')
        .trim()
        .slice(0, 1000),
      imagePrompt: String(r?.imagePrompt || '').trim(),
      seedKeyword: String(r?.seedKeyword || '')
        .trim()
        .toLowerCase(),
      offeringId: r?.offeringId ? String(r.offeringId).trim() : null,
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
