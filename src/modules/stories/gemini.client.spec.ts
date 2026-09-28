import { buildIdeasPrompt, extractImage, parseIdeas } from './gemini.client';

describe('Gemini helpers', () => {
  it('parses and trims ideas, dropping incomplete ones', () => {
    const text = JSON.stringify([
      {
        title: 'A very long festive title that overflows',
        idea: 'Idea',
        imagePrompt: 'p',
        seedKeyword: 'Diwali Sale',
        offeringId: ' off1 ',
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
        offeringId: 'off1',
      },
    ]);
  });

  it('accepts fenced JSON and rejects non-arrays', () => {
    expect(
      parseIdeas(
        '```json\n[{"title":"t","idea":"i","imagePrompt":"p","seedKeyword":"s"}]\n```',
      ),
    ).toHaveLength(1);
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
    expect(prompt).toContain(
      '5 distinct Instagram post ideas for "Chai Point" (@chaipoint)',
    );
    expect(prompt).toContain('Tea cafe in Pune');
    expect(prompt).toContain('- Masala chai (INR 40)');
    expect(prompt).toContain('Monsoon chai');
    expect(prompt).toContain(
      'Trending keywords in this niche today, best first: monsoon chai offers; ginger tea',
    );
    expect(prompt).toContain('- label:');
    expect(prompt).toContain('- caption:');
  });

  it('asks for trend keywords using the Apify hashtags and dedupes the answer', async () => {
    const { GeminiClient } = await import('./gemini.client');
    const client = new GeminiClient();
    const spy = jest
      .spyOn(client, 'generateJson')
      .mockResolvedValue([
        'Bridal Makeup ',
        'bridal makeup',
        'hd bridal base',
      ] as any);
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

  describe('when Gemini is busy', () => {
    const reply = (status: number) =>
      ({
        ok: status === 200,
        status,
        json: async () => ({ ok: true }),
        text: async () => 'This model is currently experiencing high demand',
      }) as unknown as Response;
    let fetchSpy: jest.SpyInstance;

    beforeEach(() => {
      process.env.GEMINI_API_KEY = 'test-key';
      fetchSpy = jest.spyOn(global, 'fetch');
    });
    afterEach(() => {
      fetchSpy.mockRestore();
      delete process.env.GEMINI_API_KEY;
    });

    async function client() {
      const { GeminiClient } = await import('./gemini.client');
      const c = new GeminiClient();
      const sleep = jest.spyOn(c as any, 'sleep').mockResolvedValue(undefined);
      return { c: c as any, sleep };
    }

    it('retries 503 and 429 and returns the later answer', async () => {
      fetchSpy
        .mockResolvedValueOnce(reply(503))
        .mockResolvedValueOnce(reply(429))
        .mockResolvedValueOnce(reply(200));
      const { c, sleep } = await client();
      await expect(c.call('m', {})).resolves.toEqual({ ok: true });
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls.map((a: number[]) => a[0])).toEqual([
        5000, 15000,
      ]);
    });

    it('gives up after three retries', async () => {
      fetchSpy.mockResolvedValue(reply(503));
      const { c } = await client();
      await expect(c.call('m', {})).rejects.toThrow('failed with 503');
      expect(fetchSpy).toHaveBeenCalledTimes(4);
    });

    it('does not retry a bad request', async () => {
      fetchSpy.mockResolvedValue(reply(400));
      const { c, sleep } = await client();
      await expect(c.call('m', {})).rejects.toThrow('failed with 400');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });
  });
});
