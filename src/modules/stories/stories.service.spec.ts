import { BadRequestException } from '@nestjs/common';
import { localDate, normalizeWhatsAppNumber, StoriesService } from './stories.service';

jest.mock('./story-image', () => ({
  toStoryJpeg: jest.fn(async (b: Buffer) => Buffer.concat([Buffer.from('jpg:'), b])),
  overlayText: jest.fn(async () => Buffer.from('overlay')),
}));

const MERCHANT = '919876543210';

function makeService() {
  const prisma: any = {
    storySettings: {
      findUnique: jest.fn().mockResolvedValue({ orgId: 'org1', whatsappNumber: MERCHANT, keywordDatabase: 'in' }),
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({ id: 'org1', name: 'Chai Point', timezone: 'Asia/Kolkata' }),
    },
    channel: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'ch1',
        channelIdentifier: 'ig123',
        handle: 'chaipoint',
        accessTokenEncrypted: 'enc',
      }),
    },
    product: { findMany: jest.fn().mockResolvedValue([]) },
    storyBatch: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 'b1' }),
      update: jest.fn(async ({ data }) => ({ id: 'b1', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn(),
    },
    storyOption: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
  const crypto: any = { decrypt: jest.fn().mockReturnValue('page-token') };
  const meta: any = {
    sendWhatsAppTemplate: jest.fn().mockResolvedValue(true),
    sendWhatsAppImage: jest.fn().mockResolvedValue(true),
    sendWhatsAppList: jest.fn().mockResolvedValue(true),
    sendWhatsAppMessage: jest.fn().mockResolvedValue(true),
    publishInstagramStory: jest.fn().mockResolvedValue('media99'),
  };
  const gemini: any = {
    isConfigured: () => true,
    generateIdeas: jest
      .fn()
      .mockResolvedValue(
        [1, 2, 3, 4].map((n) => ({ title: `T${n}`, idea: `I${n}`, imagePrompt: `P${n}`, seedKeyword: `seed ${n}` })),
      ),
    generateImage: jest.fn().mockResolvedValue(Buffer.from('png')),
    addTextToImage: jest.fn().mockResolvedValue(Buffer.from('lettered')),
  };
  const keywords: any = {
    research: jest.fn().mockResolvedValue({ keywords: ['masala chai'], hashtags: ['#masalachai', '#chailover'] }),
  };
  const service = new StoriesService(prisma, crypto, meta, gemini, keywords);
  return { service, prisma, meta, gemini, keywords };
}

describe('StoriesService', () => {
  beforeEach(() => {
    process.env.STORY_WA_PHONE_NUMBER_ID = 'platform-phone';
    process.env.STORY_WA_ACCESS_TOKEN = 'platform-token';
    process.env.STORY_MEDIA_SECRET = 'media-secret';
    process.env.PUBLIC_BASE_URL = 'https://reel2realbooking.in';
  });
  afterEach(() => {
    for (const k of ['STORY_WA_PHONE_NUMBER_ID', 'STORY_WA_ACCESS_TOKEN', 'STORY_MEDIA_SECRET', 'PUBLIC_BASE_URL']) {
      delete process.env[k];
    }
  });

  describe('generateBatch', () => {
    it('creates four options and sends the template with a show button', async () => {
      const { service, prisma, meta } = makeService();
      prisma.storyBatch.findUnique.mockResolvedValue(null);

      const batch = await service.generateBatch('org1');

      expect(batch.status).toBe('NOTIFIED');
      expect(prisma.storyOption.create).toHaveBeenCalledTimes(4);
      expect(prisma.storyOption.create.mock.calls[0][0].data).toMatchObject({
        batchId: 'b1',
        position: 1,
        title: 'T1',
      });
      const [phone, to, template, , components, token] = meta.sendWhatsAppTemplate.mock.calls[0];
      expect([phone, to, template, token]).toEqual(['platform-phone', MERCHANT, 'daily_story_ideas', 'platform-token']);
      expect(components[1].parameters[0].payload).toBe('STORY_SHOW_b1');
    });

    it('keeps an existing batch for today', async () => {
      const { service, prisma, gemini } = makeService();
      prisma.storyBatch.findUnique.mockResolvedValue({ id: 'old', status: 'NOTIFIED' });

      await service.generateBatch('org1');

      expect(gemini.generateIdeas).not.toHaveBeenCalled();
      expect(prisma.storyBatch.create).not.toHaveBeenCalled();
    });

    it('marks the batch failed when the template cannot be sent', async () => {
      const { service, prisma, meta } = makeService();
      prisma.storyBatch.findUnique.mockResolvedValue(null);
      meta.sendWhatsAppTemplate.mockResolvedValue(false);

      await expect(service.generateBatch('org1')).rejects.toThrow('template');
      expect(prisma.storyBatch.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
      );
    });

    it('refuses without a connected Instagram account', async () => {
      const { service, prisma } = makeService();
      prisma.channel.findFirst.mockResolvedValue(null);
      await expect(service.generateBatch('org1')).rejects.toThrow('Instagram');
    });
  });

  describe('WhatsApp replies', () => {
    it('recognises story buttons, list picks and bare digits on the platform number', () => {
      const { service } = makeService();
      expect(service.isStoryReply({ button: { payload: 'STORY_SHOW_b1' } }, 'any')).toBe(true);
      expect(service.isStoryReply({ interactive: { list_reply: { id: 'STORY_PICK_b1_2' } } }, 'any')).toBe(true);
      expect(service.isStoryReply({ text: { body: ' 3 ' } }, 'platform-phone')).toBe(true);
      expect(service.isStoryReply({ text: { body: '3' } }, 'merchant-phone')).toBe(false);
      expect(service.isStoryReply({ text: { body: 'hello' } }, 'platform-phone')).toBe(false);
      expect(service.isStoryReply({ interactive: { button_reply: { id: 'COD_CONFIRM_1' } } }, 'any')).toBe(false);
    });

    it('shows the four images and a pick list', async () => {
      const { service, prisma, meta } = makeService();
      prisma.storyBatch.findUnique.mockResolvedValue({
        id: 'b1',
        status: 'NOTIFIED',
        waRecipient: MERCHANT,
        options: [1, 2, 3, 4].map((p) => ({ id: `o${p}`, position: p, title: `T${p}`, idea: `I${p}` })),
      });

      await service.handleWhatsAppReply({ from: MERCHANT, button: { payload: 'STORY_SHOW_b1' } });

      expect(meta.sendWhatsAppImage).toHaveBeenCalledTimes(4);
      expect(meta.sendWhatsAppImage.mock.calls[0][2]).toMatch(
        /^https:\/\/reel2realbooking\.in\/api\/stories\/media\/o1\/draft\/[\w-]{32}\.jpg$/,
      );
      const rows = meta.sendWhatsAppList.mock.calls[0][4];
      expect(rows.map((r: any) => r.id)).toEqual([
        'STORY_PICK_b1_1',
        'STORY_PICK_b1_2',
        'STORY_PICK_b1_3',
        'STORY_PICK_b1_4',
      ]);
      expect(prisma.storyBatch.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { status: 'AWAITING_PICK' } });
    });

    it('ignores taps from a number the batch was not sent to', async () => {
      const { service, prisma, meta } = makeService();
      prisma.storyBatch.findUnique.mockResolvedValue({
        id: 'b1',
        status: 'NOTIFIED',
        waRecipient: MERCHANT,
        options: [],
      });
      await service.handleWhatsAppReply({ from: '911111111111', button: { payload: 'STORY_SHOW_b1' } });
      expect(meta.sendWhatsAppImage).not.toHaveBeenCalled();
      expect(meta.sendWhatsAppMessage).not.toHaveBeenCalled();
    });

    it('publishes the picked option with researched hashtags', async () => {
      const { service, prisma, meta, gemini, keywords } = makeService();
      prisma.storyBatch.findUnique.mockResolvedValue({
        id: 'b1',
        orgId: 'org1',
        status: 'AWAITING_PICK',
        waRecipient: MERCHANT,
        options: [{ id: 'o2' }],
      });
      prisma.storyOption.findUnique.mockResolvedValue({
        id: 'o2',
        title: 'Monsoon chai',
        seedKeyword: 'masala chai',
        imageData: new Uint8Array(Buffer.from('draft')),
      });

      await service.handleWhatsAppReply({ from: MERCHANT, interactive: { list_reply: { id: 'STORY_PICK_b1_2' } } });

      expect(prisma.storyBatch.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'b1', status: { in: ['NOTIFIED', 'AWAITING_PICK', 'FAILED'] } },
          data: expect.objectContaining({ status: 'PUBLISHING', selectedOptionId: 'o2' }),
        }),
      );
      expect(keywords.research).toHaveBeenCalledWith('masala chai', 'in');
      expect(gemini.addTextToImage).toHaveBeenCalledWith(expect.any(Buffer), 'image/jpeg', 'Monsoon chai', [
        '#masalachai',
        '#chailover',
      ]);
      const [igUser, url, token] = meta.publishInstagramStory.mock.calls[0];
      expect(igUser).toBe('ig123');
      expect(url).toContain('/api/stories/media/o2/final/');
      expect(token).toBe('page-token');
      expect(prisma.storyBatch.update).toHaveBeenLastCalledWith({
        where: { id: 'b1' },
        data: { status: 'PUBLISHED', publishedMediaId: 'media99' },
      });
      expect(meta.sendWhatsAppMessage.mock.calls.at(-1)[2]).toContain('#masalachai #chailover');
    });

    it('does not publish twice when the pick was already claimed', async () => {
      const { service, prisma, meta } = makeService();
      prisma.storyBatch.findUnique.mockResolvedValue({
        id: 'b1',
        status: 'PUBLISHED',
        waRecipient: MERCHANT,
        options: [{ id: 'o1' }],
      });
      prisma.storyBatch.updateMany.mockResolvedValue({ count: 0 });

      await service.pick('b1', 1, MERCHANT);

      expect(meta.publishInstagramStory).not.toHaveBeenCalled();
      expect(meta.sendWhatsAppMessage.mock.calls[0][2]).toContain('already');
    });

    it('marks the batch failed and tells the merchant when Instagram refuses', async () => {
      const { service, prisma, meta } = makeService();
      prisma.storyBatch.findUnique.mockResolvedValue({
        id: 'b1',
        orgId: 'org1',
        status: 'AWAITING_PICK',
        waRecipient: MERCHANT,
        options: [{ id: 'o1' }],
      });
      prisma.storyOption.findUnique.mockResolvedValue({
        id: 'o1',
        title: 't',
        seedKeyword: 's',
        imageData: Buffer.from('x'),
      });
      meta.publishInstagramStory.mockRejectedValue(new Error('Instagram publish story failed: bad token'));

      await service.pick('b1', 1, MERCHANT);

      expect(prisma.storyBatch.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
      );
      expect(meta.sendWhatsAppMessage.mock.calls.at(-1)[2]).toContain('bad token');
    });

    it('maps a bare digit to the latest open batch', async () => {
      const { service, prisma } = makeService();
      prisma.storyBatch.findFirst.mockResolvedValue({ id: 'b7' });
      const pick = jest.spyOn(service, 'pick').mockResolvedValue(undefined);

      await service.handleWhatsAppReply({ from: MERCHANT, text: { body: '4' } });

      expect(pick).toHaveBeenCalledWith('b7', 4, MERCHANT);
    });
  });

  describe('media', () => {
    it('serves images only for a valid signature', async () => {
      const { service, prisma } = makeService();
      prisma.storyOption.findUnique.mockResolvedValue({ imageData: Buffer.from('img'), finalImageData: null });
      const url = service.mediaUrl('o1', 'draft');
      const sig = url.split('/').pop()!;

      await expect(service.getMedia('o1', 'draft', sig)).resolves.toEqual(Buffer.from('img'));
      await expect(service.getMedia('o2', 'draft', sig)).rejects.toThrow();
      await expect(service.getMedia('o1', 'final', sig)).rejects.toThrow();
      await expect(service.getMedia('o1', 'other', sig)).rejects.toThrow();
    });
  });

  describe('settings', () => {
    it('needs a WhatsApp number before enabling', async () => {
      const { service, prisma } = makeService();
      prisma.storySettings.findUnique.mockResolvedValue(null);
      prisma.storySettings.upsert = jest.fn();
      await expect(service.updateSettings('org1', { enabled: true })).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

describe('normalizeWhatsAppNumber', () => {
  it('adds +91 to ten-digit numbers and strips formatting', () => {
    expect(normalizeWhatsAppNumber('98765 43210')).toBe('919876543210');
    expect(normalizeWhatsAppNumber('098765-43210')).toBe('919876543210');
    expect(normalizeWhatsAppNumber('+1 (415) 555-0100')).toBe('14155550100');
    expect(normalizeWhatsAppNumber('')).toBeNull();
  });

  it('rejects numbers that are too short', () => {
    expect(() => normalizeWhatsAppNumber('12345')).toThrow(BadRequestException);
  });
});

describe('localDate', () => {
  it('uses the org timezone', () => {
    const lateUtc = new Date('2026-09-25T20:00:00Z');
    expect(localDate('Asia/Kolkata', lateUtc)).toBe('2026-09-26');
    expect(localDate('UTC', lateUtc)).toBe('2026-09-25');
    expect(localDate('Not/AZone', lateUtc)).toBe('2026-09-26');
  });
});
