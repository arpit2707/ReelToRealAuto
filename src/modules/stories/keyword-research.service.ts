import { Injectable, Logger } from '@nestjs/common';

export type SemrushKeyword = {
  phrase: string;
  volume: number;
  difficulty: number;
};
export type KeywordResearch = { keywords: string[]; hashtags: string[] };

/**
 * Finds the best keywords for a story topic: search demand from Semrush and
 * the hashtags that currently travel with the topic on Instagram, via Apify.
 * Either source may be missing or fail; the other (or the seed itself) fills in.
 */
@Injectable()
export class KeywordResearchService {
  private readonly logger = new Logger(KeywordResearchService.name);

  async research(seed: string, database = 'in'): Promise<KeywordResearch> {
    const [semrush, apify] = await Promise.all([
      this.semrushRelated(seed, database).catch((e) => {
        this.logger.warn(`Semrush lookup failed for "${seed}": ${e.message}`);
        return [] as SemrushKeyword[];
      }),
      this.apifyHashtags(seed).catch((e) => {
        this.logger.warn(`Apify lookup failed for "${seed}": ${e.message}`);
        return [] as string[];
      }),
    ]);
    return combineResearch(seed, semrush, apify);
  }

  async semrushRelated(seed: string, database: string): Promise<SemrushKeyword[]> {
    const key = process.env.SEMRUSH_API_KEY;
    if (!key) return [];
    const url = new URL('https://api.semrush.com/');
    url.searchParams.set('type', 'phrase_related');
    url.searchParams.set('key', key);
    url.searchParams.set('phrase', seed);
    url.searchParams.set('database', database);
    url.searchParams.set('export_columns', 'Ph,Nq,Kd');
    url.searchParams.set('display_sort', 'nq_desc');
    url.searchParams.set('display_limit', '20');
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return parseSemrushCsv(text);
  }

  async apifyHashtags(seed: string): Promise<string[]> {
    const token = process.env.APIFY_TOKEN;
    if (!token) return [];
    const actor = process.env.APIFY_HASHTAG_ACTOR || 'apify~instagram-hashtag-scraper';
    const tag = toHashtag(seed).slice(1);
    const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?timeout=120&maxItems=40`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        hashtags: [tag],
        resultsType: 'posts',
        resultsLimit: 40,
      }),
      signal: AbortSignal.timeout(150_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const items = await res.json();
    return rankHashtags(Array.isArray(items) ? items : [], tag);
  }
}

/** Semrush answers with `Keyword;Search Volume;Keyword Difficulty Index` rows, or `ERROR nn :: ...`. */
export function parseSemrushCsv(text: string): SemrushKeyword[] {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('ERROR')) {
    // ERROR 50 means "nothing found", which is a normal empty answer.
    if (trimmed.startsWith('ERROR') && !trimmed.startsWith('ERROR 50 ')) {
      throw new Error(trimmed.slice(0, 200));
    }
    return [];
  }
  const [, ...rows] = trimmed.split(/\r?\n/);
  return rows
    .map((row) => row.split(';'))
    .filter((cols) => cols[0])
    .map((cols) => ({
      phrase: cols[0].trim(),
      volume: Number(cols[1]) || 0,
      difficulty: Number(cols[2]) || 0,
    }));
}

/** Counts which hashtags co-occur most on recent posts for the seed tag. */
export function rankHashtags(items: any[], seedTag: string, limit = 10): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const tags: string[] = Array.isArray(item?.hashtags) ? item.hashtags : extractTags(String(item?.caption || ''));
    for (const raw of new Set(tags.map((t) => String(t).replace(/^#/, '').toLowerCase()))) {
      if (!/^[\p{L}\p{N}_]{2,30}$/u.test(raw)) continue;
      counts.set(raw, (counts.get(raw) || 0) + 1);
    }
  }
  counts.delete(seedTag.toLowerCase());
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag]) => `#${tag}`);
}

function extractTags(caption: string): string[] {
  return caption.match(/#[\p{L}\p{N}_]+/gu) || [];
}

export function toHashtag(phrase: string): string {
  return `#${phrase.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')}`;
}

/**
 * Keywords: highest-volume Semrush phrases, preferring ones that are not too
 * hard to rank for. Hashtags: the seed, then the Semrush winners as tags,
 * then Instagram's co-occurring tags, capped so the story stays readable.
 */
export function combineResearch(seed: string, semrush: SemrushKeyword[], apify: string[]): KeywordResearch {
  const ranked = [...semrush]
    .filter((k) => k.phrase && k.volume > 0)
    .sort((a, b) => score(b) - score(a))
    .map((k) => k.phrase.toLowerCase());
  const keywords = unique([seed.toLowerCase(), ...ranked]).slice(0, 5);

  const hashtags = unique([toHashtag(seed), ...ranked.slice(0, 2).map(toHashtag), ...apify])
    .filter((t) => t.length > 2 && t.length <= 31)
    .slice(0, 6);
  return { keywords, hashtags };
}

function score(k: SemrushKeyword): number {
  // Volume matters most; difficulty above ~70 is rarely winnable for a small shop.
  return Math.log10(k.volume + 1) * (k.difficulty > 70 ? 0.6 : 1);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
