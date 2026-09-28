import { AiClientService } from './ai-client.service';

describe('AiClientService while the AI service wakes up', () => {
  const res = (status: number, body: unknown = { public_reply: 'Hi', private_dm: 'Details', intent: 'price' }) =>
    ({
      ok: status === 200,
      status,
      json: async () => body,
      text: async () => '<!DOCTYPE html><title>502</title>',
    }) as unknown as Response;
  const payload = {
    brand_id: 'org1',
    channel_type: 'instagram',
    event_type: 'comment',
    message_text: 'Price kya hai?',
    sender_id: 's1',
  };
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });
  afterEach(() => fetchSpy.mockRestore());

  function client() {
    const c = new AiClientService();
    const sleep = jest.spyOn(c as any, 'sleep').mockResolvedValue(undefined);
    return { c, sleep };
  }

  it("retries Render's 502 and dropped connections until the service answers", async () => {
    fetchSpy
      .mockResolvedValueOnce(res(502))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(res(503))
      .mockResolvedValueOnce(res(200));
    const { c, sleep } = client();
    const out = await c.generateReply(payload);
    expect(out.private_dm).toBe('Details');
    expect(sleep.mock.calls.map((a) => a[0])).toEqual([10000, 20000, 30000]);
  });

  it('hands over to a human after about 90 seconds of 502s', async () => {
    fetchSpy.mockResolvedValue(res(502));
    const { c } = client();
    const out = await c.generateReply(payload);
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    expect(out).toMatchObject({ intent: 'ai_unavailable', requires_human_attention: true });
  });

  it('does not retry a rejected request', async () => {
    fetchSpy.mockResolvedValue(res(401));
    const { c, sleep } = client();
    const out = await c.generateReply(payload);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(out.intent).toBe('ai_unavailable');
  });
});
