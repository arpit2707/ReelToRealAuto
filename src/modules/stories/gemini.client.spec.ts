import { buildIdeasPrompt, extractImage, parseIdeas } from './gemini.client';

describe('Gemini helpers', () => {
  it('parses and trims ideas, dropping incomplete ones', () => {
    const text = JSON.stringify([
      {
        title: 'A very long festive title that overflows',
        idea: 'Idea',
        imagePrompt: 'p',
        seedKeyword: 'Diwali Sale',
      },
      { title: 'Missing prompt', idea: 'x', seedKeyword: 'y' },
    ]);
    expect(parseIdeas(text)).toEqual([
      {
        title: 'A very long festive titl',
        label: '',
        idea: 'Idea',
        caption: '',
        imagePrompt: 'p',
        seedKeyword: 'diwali sale',
      },
    ]);
  });

  it('accepts fenced JSON and rejects non-arrays', () => {
    expect(parseIdeas('```json\n[{"title":"t","idea":"i","imagePrompt":"p","seedKeyword":"s"}]\n```')).toHaveLength(1);
    expect(parseIdeas('{"title":"t"}')).toEqual([]);
    expect(parseIdeas('not json')).toEqual([]);
  });

  it('extracts inline image bytes', () => {
    const json = {
      candidates: [
        {
          content: {
            parts: [{ text: 'hi' }, { inlineData: { data: 'aGVsbG8=' } }],
          },
        },
      ],
    };
    expect(extractImage(json).toString()).toBe('hello');
  });

  it('explains a missing image', () => {
    expect(() =>
      extractImage({
        candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }],
      }),
    ).toThrow('SAFETY');
  });

  it('includes business context in the prompt', () => {
    const prompt = buildIdeasPrompt(
      {
        brandName: 'Chai Point',
        instagramHandle: 'chaipoint',
        description: 'Tea cafe in Pune',
        products: [{ title: 'Masala chai', price: 40, currency: 'INR' }],
        recentTitles: ['Monsoon chai'],
        forDate: '2026-09-25',
        trendKeywords: ['monsoon chai offers', 'ginger tea'],
      },
      5,
    );
    expect(prompt).toContain('5 distinct Instagram post ideas for "Chai Point" (@chaipoint)');
    expect(prompt).toContain('Tea cafe in Pune');
    expect(prompt).toContain('- Masala chai (INR 40)');
    expect(prompt).toContain('Monsoon chai');
    expect(prompt).toContain('Trending keywords in this niche today, best first: monsoon chai offers; ginger tea');
    expect(prompt).toContain('- label:');
    expect(prompt).toContain('- caption:');
  });

  it('asks for trend keywords using the Apify hashtags and dedupes the answer', async () => {
    const { GeminiClient } = await import('./gemini.client');
    const client = new GeminiClient();
    const spy = jest
      .spyOn(client, 'generateJson')
      .mockResolvedValue(['Bridal Makeup ', 'bridal makeup', 'hd bridal base'] as any);
    const out = await client.trendKeywords({
      industry: 'BRIDAL_MAKEUP',
      description: 'Bridal makeup artist in Patna',
      seeds: ['bridal makeup'],
      trendingHashtags: ['#weddingseason'],
      forDate: '2026-11-01',
    });
    expect(out).toEqual(['bridal makeup', 'hd bridal base']);
    expect(spy.mock.calls[0][0]).toContain('#weddingseason');
  });
});
