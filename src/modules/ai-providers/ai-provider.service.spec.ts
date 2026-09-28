import { AiProviderService } from './ai-provider.service';
import { objectSchema, toJsonSchema } from './llm.client';

const crypto: any = { encrypt: (v: string) => `enc:${v}`, decrypt: (v: string) => v.replace(/^enc:/, '') };

function makeService(rows: { keys?: any[]; settings?: any[] } = {}) {
  const keys = rows.keys || [];
  const settings = rows.settings || [];
  const prisma: any = {
    aiProviderKey: {
      findMany: jest.fn(async ({ where }: any) => keys.filter((k) => (k.orgId ?? null) === where.orgId)),
    },
    aiServiceSetting: {
      findMany: jest.fn(async ({ where }: any) => settings.filter((s) => (s.orgId ?? null) === where.orgId)),
      findFirst: jest.fn(
        async ({ where }: any) =>
          settings.find((s) => (s.orgId ?? null) === where.orgId && s.service === where.service) || null,
      ),
    },
  };
  return new AiProviderService(prisma, crypto);
}

const key = (provider: string, orgId: string | null = null, model: string | null = null) => ({
  orgId,
  provider,
  apiKeyEnc: `enc:${provider.toLowerCase()}-${orgId || 'platform'}`,
  keyHint: '…1234',
  model,
});

describe('AiProviderService.resolve', () => {
  const env = { ...process.env };
  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterAll(() => {
    process.env = env;
  });

  it('keeps using the env Gemini key when nothing was set up', async () => {
    process.env.GEMINI_API_KEY = 'env-gemini';
    const ai = await makeService().resolve('org1', 'POST_TEXT');
    expect(ai).toMatchObject({ provider: 'GEMINI', apiKey: 'env-gemini', source: 'ENV' });
  });

  it('is not configured without any key', async () => {
    expect(await makeService().resolve('org1', 'POST_TEXT')).toBeNull();
  });

  it('uses the provider the superadmin picked for the service', async () => {
    const service = makeService({
      keys: [key('GEMINI'), key('CLAUDE', null, 'claude-haiku-4-5-20251001')],
      settings: [{ orgId: null, service: 'DM_REPLIES', provider: 'CLAUDE', model: null, tenantCanChoose: false }],
    });
    expect(await service.resolve('org1', 'DM_REPLIES')).toEqual({
      provider: 'CLAUDE',
      apiKey: 'claude-platform',
      model: 'claude-haiku-4-5-20251001',
      source: 'PLATFORM',
    });
    // Other services still default to Gemini.
    expect((await service.resolve('org1', 'POST_TEXT'))?.provider).toBe('GEMINI');
  });

  it("ignores a workspace's own choice unless the platform lets tenants choose", async () => {
    const settings = [
      { orgId: null, service: 'POST_TEXT', provider: 'GEMINI', model: null, tenantCanChoose: false },
      { orgId: 'org1', service: 'POST_TEXT', provider: 'OPENAI', model: null },
    ];
    const keys = [key('GEMINI'), key('OPENAI', 'org1')];
    expect((await makeService({ keys, settings }).resolve('org1', 'POST_TEXT'))?.source).toBe('PLATFORM');
    settings[0].tenantCanChoose = true;
    expect(await makeService({ keys, settings }).resolve('org1', 'POST_TEXT')).toMatchObject({
      provider: 'OPENAI',
      apiKey: 'openai-org1',
      source: 'WORKSPACE',
    });
  });

  it('falls back to the platform when the workspace picked a provider it has no key for', async () => {
    const service = makeService({
      keys: [key('GEMINI')],
      settings: [
        { orgId: null, service: 'POST_TEXT', provider: 'GEMINI', model: null, tenantCanChoose: true },
        { orgId: 'org1', service: 'POST_TEXT', provider: 'CLAUDE', model: null },
      ],
    });
    expect(await service.resolve('org1', 'POST_TEXT')).toMatchObject({ provider: 'GEMINI', source: 'PLATFORM' });
  });

  it('never gives images to Claude and uses the image model', async () => {
    const service = makeService({ keys: [key('CLAUDE'), key('OPENAI', null, 'gpt-5-mini')] });
    expect(await service.resolve('org1', 'POST_IMAGES')).toMatchObject({ provider: 'OPENAI', model: 'gpt-image-1' });
  });
});

describe('schema conversion', () => {
  it('turns the Gemini dialect into JSON Schema and wraps arrays', () => {
    const gemini = { type: 'ARRAY', items: { type: 'OBJECT', properties: { a: { type: 'STRING' } }, required: ['a'] } };
    expect(toJsonSchema(gemini)).toEqual({
      type: 'array',
      items: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
    });
    expect(objectSchema(gemini)).toMatchObject({ wrapped: true, schema: { type: 'object', required: ['result'] } });
    expect(objectSchema({ type: 'OBJECT', properties: {} }).wrapped).toBe(false);
  });
});
