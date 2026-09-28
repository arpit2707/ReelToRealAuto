import { LlmClient } from './llm.client';
import type { ResolvedAi } from './ai-providers.types';

describe('LlmClient when the provider is busy', () => {
  const reply = (status: number, body: unknown = { candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }] }) =>
    ({
      ok: status === 200,
      status,
      json: async () => body,
      text: async () => 'This model is currently experiencing high demand',
    }) as unknown as Response;
  const gemini: ResolvedAi = { provider: 'GEMINI', apiKey: 'k', model: 'main-model', source: 'ENV' };
  const req = { prompt: 'p', schema: { type: 'OBJECT', properties: {} } };
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env.GEMINI_TEXT_FALLBACK_MODEL;
  });

  function client() {
    const c = new LlmClient();
    const sleep = jest.spyOn(c as any, 'sleep').mockResolvedValue(undefined);
    return { c, sleep };
  }

  it('retries 503 and 429 and returns the later answer', async () => {
    fetchSpy.mockResolvedValueOnce(reply(503)).mockResolvedValueOnce(reply(429)).mockResolvedValueOnce(reply(200));
    const { c, sleep } = client();
    await expect(c.generateJson(gemini, req)).resolves.toEqual({ a: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((a) => a[0])).toEqual([5000, 15000]);
  });

  it('switches a still-busy Gemini text model to the fallback model', async () => {
    process.env.GEMINI_TEXT_FALLBACK_MODEL = 'spare-model';
    fetchSpy
      .mockResolvedValueOnce(reply(503))
      .mockResolvedValueOnce(reply(503))
      .mockResolvedValueOnce(reply(503))
      .mockResolvedValueOnce(reply(503))
      .mockResolvedValueOnce(reply(200));
    const { c } = client();
    await expect(c.generateJson(gemini, req)).resolves.toEqual({ a: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    expect(String(fetchSpy.mock.calls[4][0])).toContain('spare-model');
  });

  it('gives up on images after three retries (no text fallback)', async () => {
    fetchSpy.mockResolvedValue(reply(503));
    const { c } = client();
    await expect(c.generateImage(gemini, 'p')).rejects.toThrow('failed with 503');
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('does not retry a bad request', async () => {
    fetchSpy.mockResolvedValue(reply(400));
    const { c, sleep } = client();
    await expect(c.generateJson(gemini, req)).rejects.toThrow('failed with 400');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
