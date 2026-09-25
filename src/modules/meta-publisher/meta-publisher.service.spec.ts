import { MetaPublisherService } from './meta-publisher.service';

describe('MetaPublisherService.publishInstagramStory', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body }) as any;

  it('creates a STORIES container, waits for it, then publishes', async () => {
    const calls: string[] = [];
    const responses = [
      json({ id: 'c1' }),
      json({ status_code: 'IN_PROGRESS' }),
      json({ status_code: 'FINISHED' }),
      json({ id: 'm1' }),
    ];
    global.fetch = jest.fn(async (url: any, init?: any) => {
      calls.push(`${init?.method || 'GET'} ${String(url)}`);
      return responses.shift();
    }) as any;

    const id = await new MetaPublisherService().publishInstagramStory('ig1', 'https://x/img.jpg', 'tok', {
      pollIntervalMs: 0,
    });

    expect(id).toBe('m1');
    expect(calls[0]).toMatch(
      /^POST https:\/\/graph\.facebook\.com\/v\d+\.\d+\/ig1\/media\?media_type=STORIES&image_url=/,
    );
    expect(calls[3]).toContain('/ig1/media_publish?creation_id=c1');
  });

  it('surfaces the Graph API error message', async () => {
    global.fetch = jest.fn(async () => json({ error: { message: 'Invalid OAuth access token' } }, false)) as any;
    await expect(new MetaPublisherService().publishInstagramStory('ig1', 'u', 'tok')).rejects.toThrow(
      'Invalid OAuth access token',
    );
  });

  it('fails when the container errors', async () => {
    const responses = [json({ id: 'c1' }), json({ status_code: 'ERROR', status: 'Unsupported format' })];
    global.fetch = jest.fn(async () => responses.shift()) as any;
    await expect(
      new MetaPublisherService().publishInstagramStory('ig1', 'u', 'tok', { pollIntervalMs: 0 }),
    ).rejects.toThrow('Unsupported format');
  });
});
