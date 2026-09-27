import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  decodeImage,
  localDate,
  localTime,
  nextDate,
  normalizeTime,
  normalizeWhatsAppNumber,
  parseScheduleTime,
  StoriesService,
  zonedDateTime,
} from './stories.service';

jest.mock('./story-image', () => ({
  toStoryJpeg: jest.fn(async (b: Buffer) => Buffer.concat([Buffer.from('jpg:'), b])),
  toFeedJpeg: jest.fn(async (b: Buffer) => Buffer.concat([Buffer.from('feed:'), b])),
  toPaddedStoryJpeg: jest.fn(async (b: Buffer) => Buffer.concat([Buffer.from('padded:'), b])),
  overlayText: jest.fn(async () => Buffer.from('overlay')),
}));

const MERCHANT = '919876543210';
// 2026-09-28 10:00 IST: after the 09:00 send time, before the 19:00 post time.
const MORNING = new Date('2026-09-28T04:30:00Z');
const NIGHT = new Date('2026-09-28T15:00:00Z'); // 20:30 IST

function makeService(settingsOver: any = {}) {
  const settings = {
    orgId: 'org1',
    whatsappNumber: MERCHANT,
    keywordDatabase: 'in',
    sendTime: '09:00',
    postTime: '19:00',
    optionCount: 5,
    destinations: ['IG_STORY'],
    nicheKeywords: ['bridal makeup'],
    ...settingsOver,
  };
  const channels: Record<string, any> = {
    INSTAGRAM: {
      id: 'ch1',
      channelIdentifier: 'ig123',
      handle: 'glowbride',
      accessTokenEncrypted: 'enc',
    },
    FACEBOOK: {
      id: 'ch2',
      channelIdentifier: 'page9',
      accessTokenEncrypted: 'enc',
    },
  };
  const prisma: any = {
    storySettings: {
      findUnique: jest.fn().mockResolvedValue(settings),
      findMany: jest.fn().mockResolvedValue([]),
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'org1',
        name: 'Glow Bride',
        timezone: 'Asia/Kolkata',
      }),
    },
    businessProfile: {
      findUnique: jest.fn().mockResolvedValue({
        industry: 'BRIDAL_MAKEUP',
        description: 'Bridal makeup in Patna',
      }),
    },
    channel: {
      findFirst: jest.fn(async ({ where }) => channels[where.platform] ?? null),
    },
    offering: { findMany: jest.fn().mockResolvedValue([]) },
    pageProfile: { findFirst: jest.fn().mockResolvedValue(null) },
    socialPost: { upsert: jest.fn().mockResolvedValue({}) },
    postOfferingLink: { upsert: jest.fn().mockResolvedValue({}) },
    storyBatch: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'b1' }),
      update: jest.fn(async ({ data }) => ({ id: 'b1', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn(),
    },
    storyOption: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(async ({ data }) => ({
        id: 'o2',
        position: 2,
        title: 'T2',
        label: 'L2',
        idea: 'I2',
        ...data,
      })),
    },
  };
  const crypto: any = { decrypt: jest.fn().mockReturnValue('page-token') };
  const meta: any = {
    sendWhatsAppTemplate: jest.fn().mockResolvedValue(true),
    sendWhatsAppImage: jest.fn().mockResolvedValue(true),
    sendWhatsAppImageButtons: jest.fn().mockResolvedValue(true),
    sendWhatsAppMessage: jest.fn().mockResolvedValue(true),
    sendInteractiveButtonMessage: jest.fn().mockResolvedValue(false),
    downloadWhatsAppMedia: jest.fn().mockResolvedValue({ data: Buffer.from('photo'), mimeType: 'image/jpeg' }),
    publishInstagramStory: jest.fn().mockResolvedValue('story99'),
    publishInstagramFeed: jest.fn().mockResolvedValue('feed99'),
    publishFacebookPhoto: jest.fn().mockResolvedValue('fb99'),
  };
  const gemini: any = {
    isConfigured: () => true,
    trendKeywords: jest.fn().mockResolvedValue(['hd bridal makeup', 'wedding season looks']),
    generateIdeas: jest.fn(async (_ctx: any, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        title: `T${i + 1}`,
        label: i === 0 ? '' : `Trending ${i + 1}`,
        idea: `I${i + 1}`,
        caption: `Caption ${i + 1}`,
        imagePrompt: `P${i + 1}`,
        seedKeyword: `seed ${i + 1}`,
      })),
    ),
    generateImage: jest.fn().mockResolvedValue(Buffer.from('png')),
    editImage: jest.fn().mockResolvedValue(Buffer.from('edited')),
    addTextToImage: jest.fn().mockResolvedValue(Buffer.from('lettered')),
    describeOwnPhoto: jest.fn().mockResolvedValue({
      title: 'New lehenga',
      caption: 'Naya lehenga aa gaya!',
      seedKeyword: 'bridal lehenga',
      offeringId: 'off1',
    }),
  };
  const keywords: any = {
    apifyHashtags: jest.fn().mockResolvedValue(['#weddingseason', '#bridalmakeup']),
    research: jest.fn().mockResolvedValue({
      keywords: ['bridal makeup'],
      hashtags: ['#bridalmakeup', '#hdmakeup'],
    }),
  };
  const service = new StoriesService(prisma, crypto, meta, gemini, keywords);
  return { service, prisma, meta, gemini, keywords, settings };
}

const openBatch = (over: any = {}) => ({
  id: 'b1',
  orgId: 'org1',
  forDate: '2026-09-28',
  status: 'AWAITING_PICK',
  waRecipient: MERCHANT,
  options: [{ id: 'o2' }],
  ...over,
});

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
    it('researches trends first, then creates labelled options and sends the template', async () => {
      const { service, prisma, meta, gemini, keywords } = makeService();
      prisma.storyBatch.findUnique.mockResolvedValue(null);

      const batch = await service.generateBatch('org1');

      expect(batch.status).toBe('NOTIFIED');
      expect(keywords.apifyHashtags).toHaveBeenCalledWith('bridal makeup');
      expect(gemini.trendKeywords.mock.calls[0][0].trendingHashtags).toEqual(['#weddingseason', '#bridalmakeup']);
      expect(prisma.storyBatch.update).toHaveBeenCalledWith({
        where: { id: 'b1' },
        data: { trendKeywords: ['hd bridal makeup', 'wedding season looks'] },
      });
      const [ctx, count] = gemini.generateIdeas.mock.calls[0];
      expect(count).toBe(5);
      expect(ctx.trendKeywords).toEqual(['hd bridal makeup', 'wedding season looks']);
      expect(prisma.storyOption.create).toHaveBeenCalledTimes(5);
      expect(prisma.storyOption.create.mock.calls[0][0].data).toMatchObject({
        position: 1,
        title: 'T1',
        label: 'Trending: seed 1',
        caption: 'Caption 1',
      });
      expect(prisma.storyOption.create.mock.calls[1][0].data.label).toBe('Trending 2');
      const [, to, template, , components] = meta.sendWhatsAppTemplate.mock.calls[0];
      expect([to, template]).toEqual([MERCHANT, 'daily_story_ideas']);
      expect(components[1].parameters[0].payload).toBe('STORY_SHOW_b1');
    });

    it('still works when Apify and Gemini trend ranking both fail', async () => {
      const { service, prisma, gemini, keywords } = makeService();
      prisma.storyBatch.findUnique.mockResolvedValue(null);
      keywords.apifyHashtags.mockRejectedValue(new Error('no token'));
      gemini.trendKeywords.mockRejectedValue(new Error('quota'));

      await service.generateBatch('org1');

      // Seller seed and the industry name collapse into one seed.
      expect(gemini.generateIdeas.mock.calls[0][0].trendKeywords).toEqual(['bridal makeup']);
    });

    it('keeps an existing batch for today', async () => {
      const { service, prisma, gemini } = makeService();
      prisma.storyBatch.findFirst.mockResolvedValue({
        id: 'old',
        status: 'NOTIFIED',
      });
      await service.generateBatch('org1');
      expect(gemini.generateIdeas).not.toHaveBeenCalled();
    });

    it('marks the batch failed when the template cannot be sent', async () => {
      const { service, prisma, meta } = makeService();
      prisma.storyBatch.findUnique.mockResolvedValue(null);
      meta.sendWhatsAppTemplate.mockResolvedValue(false);
      await expect(service.generateBatch('org1')).rejects.toThrow('template');
      expect(prisma.storyBatch.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'FAILED' }),
        }),
      );
    });

    it('needs a Facebook Page only when posting to Facebook', async () => {
      const { service, prisma } = makeService({ destinations: ['FB_FEED'] });
      prisma.channel.findFirst.mockImplementation(async ({ where }: any) =>
        where.platform === 'INSTAGRAM' ? { id: 'ch1' } : null,
      );
      await expect(service.generateBatch('org1')).rejects.toThrow('Facebook Page');
    });
  });

  describe('runDaily', () => {
    it('only starts orgs whose send time has passed and that have no batch today', async () => {
      const { service, prisma } = makeService();
      prisma.storySettings.findMany.mockResolvedValue([
        {
          orgId: 'early',
          sendTime: '09:00',
          org: { timezone: 'Asia/Kolkata' },
        },
        { orgId: 'late', sendTime: '11:00', org: { timezone: 'Asia/Kolkata' } },
        { orgId: 'done', sendTime: '08:00', org: { timezone: 'Asia/Kolkata' } },
      ]);
      prisma.storyBatch.findFirst.mockImplementation(async ({ where }: any) =>
        where.orgId === 'done' && where.kind === 'DAILY' ? { id: 'x' } : null,
      );
      const generate = jest.spyOn(service, 'generateBatch').mockResolvedValue({} as any);

      const r = await service.runDaily(MORNING);

      expect(generate.mock.calls.map((c) => c[0])).toEqual(['early']);
      expect(r).toMatchObject({ started: true, orgs: 1 });
    });
  });

  describe('WhatsApp replies', () => {
    it('recognises its buttons, digits, and free text only while an edit is open', async () => {
      const { service, prisma } = makeService();
      expect(await service.isStoryReply({ button: { payload: 'STORY_SHOW_b1' } }, 'any')).toBe(true);
      expect(await service.isStoryReply({ interactive: { button_reply: { id: 'STORY_POST_b1_2' } } }, 'any')).toBe(
        true,
      );
      expect(await service.isStoryReply({ interactive: { button_reply: { id: 'STORY_EDIT_b1_2' } } }, 'any')).toBe(
        true,
      );
      expect(await service.isStoryReply({ text: { body: ' 5 ' } }, 'platform-phone')).toBe(true);
      expect(await service.isStoryReply({ text: { body: '3' } }, 'merchant-phone')).toBe(false);
      expect(await service.isStoryReply({ interactive: { button_reply: { id: 'COD_CONFIRM_1' } } }, 'any')).toBe(false);

      prisma.storyBatch.findFirst.mockResolvedValue(null);
      expect(await service.isStoryReply({ from: MERCHANT, text: { body: 'hello' } }, 'platform-phone')).toBe(false);
      prisma.storyBatch.findFirst.mockResolvedValue({ id: 'b1' });
      expect(
        await service.isStoryReply({ from: MERCHANT, text: { body: 'background red karo' } }, 'platform-phone'),
      ).toBe(true);
    });

    it('shows each option as an image with Post this and Edit buttons', async () => {
      const { service, prisma, meta } = makeService();
      prisma.storyBatch.findUnique.mockResolvedValue(
        openBatch({
          status: 'NOTIFIED',
          options: [1, 2].map((p) => ({
            id: `o${p}`,
            position: p,
            title: `T${p}`,
            label: `L${p}`,
            idea: `I${p}`,
          })),
        }),
      );

      await service.handleWhatsAppReply({
        from: MERCHANT,
        button: { payload: 'STORY_SHOW_b1' },
      });

      expect(meta.sendWhatsAppImageButtons).toHaveBeenCalledTimes(2);
      const [, to, url, body, buttons] = meta.sendWhatsAppImageButtons.mock.calls[0];
      expect(to).toBe(MERCHANT);
      expect(url).toMatch(/^https:\/\/reel2realbooking\.in\/api\/stories\/media\/o1\/draft\/[\w-]{32}\.jpg$/);
      expect(body).toBe('1. [L1] *T1*\nI1');
      expect(buttons).toEqual([
        { id: 'STORY_POST_b1_1', title: 'Post this' },
        { id: 'STORY_EDIT_b1_1', title: 'Edit' },
      ]);
      expect(meta.sendWhatsAppMessage.mock.calls.at(-1)[2]).toContain('19:00');
      expect(prisma.storyBatch.update).toHaveBeenCalledWith({
        where: { id: 'b1' },
        data: { status: 'AWAITING_PICK' },
      });
    });

    it('falls back to a plain image when the buttons cannot be sent', async () => {
      const { service, prisma, meta } = makeService();
      meta.sendWhatsAppImageButtons.mockResolvedValue(false);
      prisma.storyBatch.findUnique.mockResolvedValue(
        openBatch({
          options: [{ id: 'o1', position: 1, title: 'T1', label: '', idea: 'I1' }],
        }),
      );
      await service.showOptions('b1', MERCHANT);
      expect(meta.sendWhatsAppImage.mock.calls[0][3]).toContain('1 bhejiye');
    });

    it('ignores taps from a number the batch was not sent to', async () => {
      const { service, prisma, meta } = makeService();
      prisma.storyBatch.findUnique.mockResolvedValue(openBatch());
      await service.handleWhatsAppReply({
        from: '911111111111',
        button: { payload: 'STORY_SHOW_b1' },
      });
      await service.handleWhatsAppReply({
        from: '911111111111',
        interactive: { button_reply: { id: 'STORY_POST_b1_2' } },
      });
      expect(meta.sendWhatsAppImageButtons).not.toHaveBeenCalled();
      expect(meta.sendWhatsAppMessage).not.toHaveBeenCalled();
      expect(prisma.storyBatch.updateMany).not.toHaveBeenCalled();
    });

    it('Post this schedules the option for the posting time', async () => {
      const { service, prisma, meta } = makeService();
      prisma.storyBatch.findUnique.mockResolvedValue(openBatch());

      await service.pick('b1', 2, MERCHANT, MORNING);

      expect(prisma.storyBatch.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'b1',
          status: { in: ['NOTIFIED', 'AWAITING_PICK', 'SCHEDULED', 'FAILED'] },
        },
        data: {
          status: 'SCHEDULED',
          selectedOptionId: 'o2',
          scheduledFor: new Date('2026-09-28T13:30:00Z'),
          editingOptionId: null,
        },
      });
      expect(meta.publishInstagramStory).not.toHaveBeenCalled();
      expect(meta.sendWhatsAppMessage.mock.calls[0][2]).toContain('19:00 baje Instagram story');
    });

    it('asks "now or tomorrow" instead of posting when the posting time has passed', async () => {
      const { service, prisma, meta } = makeService();
      prisma.storyBatch.findUnique.mockResolvedValue(openBatch());
      meta.sendInteractiveButtonMessage.mockResolvedValue(true);
      const publish = jest.spyOn(service, 'publishBatch').mockResolvedValue(true);

      await service.pick('b1', 2, MERCHANT, NIGHT);

      expect(publish).not.toHaveBeenCalled();
      expect(prisma.storyBatch.updateMany).not.toHaveBeenCalled();
      const buttons = meta.sendInteractiveButtonMessage.mock.calls[0][5];
      expect(buttons).toEqual([
        { id: 'STORY_NOW_b1_2', title: 'Abhi post karo' },
        { id: 'STORY_TMRW_b1_2', title: 'Kal 19:00 baje' },
      ]);
    });

    it('"Abhi post karo" publishes right away', async () => {
      const { service, prisma } = makeService();
      prisma.storyBatch.findUnique.mockResolvedValue(openBatch());
      const publish = jest.spyOn(service, 'publishBatch').mockResolvedValue(true);

      await service.handleWhatsAppReply({ from: MERCHANT, interactive: { button_reply: { id: 'STORY_NOW_b1_2' } } });

      expect(prisma.storyBatch.updateMany.mock.calls[0][0].data).toMatchObject({ selectedOptionId: 'o2' });
      expect(prisma.storyBatch.updateMany.mock.calls[0][0].data.status).toBeUndefined();
      expect(publish).toHaveBeenCalledWith('b1');
    });

    it('"Kal" schedules for tomorrow\'s posting time', async () => {
      const { service, prisma, meta } = makeService();
      prisma.storyBatch.findUnique.mockResolvedValue(openBatch());

      await service.pick('b1', 2, MERCHANT, NIGHT, 'tomorrow');

      expect(prisma.storyBatch.updateMany.mock.calls[0][0].data).toMatchObject({
        status: 'SCHEDULED',
        scheduledFor: new Date('2026-09-29T13:30:00Z'),
      });
      expect(meta.sendWhatsAppMessage.mock.calls[0][2]).toContain('kal 19:00 baje');
    });

    it('confirms a schedule with a Cancel button, and Cancel takes it off the calendar', async () => {
      const { service, prisma, meta } = makeService();
      prisma.storyBatch.findUnique.mockResolvedValue(openBatch());
      meta.sendInteractiveButtonMessage.mockResolvedValue(true);

      await service.pick('b1', 2, MERCHANT, MORNING);
      expect(meta.sendInteractiveButtonMessage.mock.calls[0][5]).toEqual([{ id: 'STORY_CANCEL_b1', title: 'Cancel' }]);

      prisma.storyBatch.findUnique.mockResolvedValue({ waRecipient: MERCHANT, status: 'SCHEDULED' });
      prisma.storyBatch.updateMany.mockClear();
      await service.handleWhatsAppReply({ from: MERCHANT, interactive: { button_reply: { id: 'STORY_CANCEL_b1' } } });
      expect(prisma.storyBatch.updateMany).toHaveBeenCalledWith({
        where: { id: 'b1', status: 'SCHEDULED' },
        data: { status: 'AWAITING_PICK', selectedOptionId: null, scheduledFor: null },
      });
      expect(meta.sendWhatsAppMessage.mock.calls.at(-1)[2]).toContain('cancel ho gaya');
    });

    it('"caption: ..." changes only the caption', async () => {
      const { service, prisma, gemini, meta } = makeService();
      prisma.storyOption.update.mockResolvedValue({
        id: 'o2',
        position: 2,
        title: 'T2',
        label: 'L2',
        idea: 'I2',
        caption: 'Aaj book karo',
      });

      await service.applyEdit('b1', 'o2', 'Caption: Aaj book karo', MERCHANT);

      expect(gemini.editImage).not.toHaveBeenCalled();
      expect(prisma.storyOption.update).toHaveBeenCalledWith({ where: { id: 'o2' }, data: { caption: 'Aaj book karo' } });
      expect(meta.sendWhatsAppImageButtons.mock.calls[0][3]).toContain('Caption: Aaj book karo');
    });

    it('tells the merchant when the post already went out', async () => {
      const { service, prisma, meta } = makeService();
      prisma.storyBatch.findUnique.mockResolvedValue(openBatch({ status: 'PUBLISHED' }));
      await service.pick('b1', 1, MERCHANT, MORNING);
      expect(prisma.storyBatch.updateMany).not.toHaveBeenCalled();
      expect(meta.sendWhatsAppMessage.mock.calls[0][2]).toContain('already');
    });

    it('Edit asks what to change, and the next message edits that image and resends it', async () => {
      const { service, prisma, meta, gemini } = makeService();
      prisma.storyBatch.findUnique.mockResolvedValue(openBatch());

      await service.handleWhatsAppReply({
        from: MERCHANT,
        interactive: { button_reply: { id: 'STORY_EDIT_b1_2' } },
      });
      expect(prisma.storyBatch.update).toHaveBeenCalledWith({
        where: { id: 'b1' },
        data: { editingOptionId: 'o2' },
      });
      expect(meta.sendWhatsAppMessage.mock.calls[0][2]).toContain('kya badalna hai');

      prisma.storyBatch.findFirst.mockResolvedValue({
        id: 'b1',
        editingOptionId: 'o2',
      });
      prisma.storyOption.findUnique.mockResolvedValue({
        id: 'o2',
        imageData: Buffer.from('draft'),
      });
      await service.handleWhatsAppReply({
        from: MERCHANT,
        text: { body: 'background golden karo' },
      });

      expect(prisma.storyBatch.updateMany).toHaveBeenCalledWith({
        where: { id: 'b1', editingOptionId: 'o2' },
        data: { editingOptionId: null },
      });
      expect(gemini.editImage).toHaveBeenCalledWith(expect.any(Buffer), 'image/jpeg', 'background golden karo');
      expect(prisma.storyOption.update.mock.calls[0][0].data).toMatchObject({
        finalImageData: null,
        revision: { increment: 1 },
      });
      expect(meta.sendWhatsAppImageButtons.mock.calls[0][4][0].id).toBe('STORY_POST_b1_2');
    });

    it('does not run an edit twice when the webhook is retried', async () => {
      const { service, prisma, gemini } = makeService();
      prisma.storyBatch.updateMany.mockResolvedValue({ count: 0 });
      await service.applyEdit('b1', 'o2', 'x', MERCHANT);
      expect(gemini.editImage).not.toHaveBeenCalled();
    });
  });

  describe('publishing', () => {
    const option = {
      id: 'o2',
      title: 'Bridal glow',
      caption: 'Book your bridal trial today.',
      seedKeyword: 'hd bridal makeup',
      imageData: Buffer.from('draft'),
      batch: { trendKeywords: ['wedding season looks'] },
    };

    it('posts to every chosen destination with the caption and hashtags', async () => {
      const { service, prisma, meta, gemini } = makeService({
        destinations: ['IG_STORY', 'IG_FEED', 'FB_FEED'],
      });
      prisma.storyBatch.findUnique.mockResolvedValue({
        id: 'b1',
        orgId: 'org1',
        selectedOptionId: 'o2',
        waRecipient: MERCHANT,
      });
      prisma.storyOption.findUnique.mockResolvedValue(option);

      expect(await service.publishBatch('b1')).toBe(true);

      expect(gemini.addTextToImage).toHaveBeenCalledWith(expect.any(Buffer), 'image/jpeg', 'Bridal glow', [
        '#bridalmakeup',
        '#hdmakeup',
      ]);
      expect(meta.publishInstagramStory.mock.calls[0][1]).toContain('/media/o2/final/');
      const [igUser, feedUrl, caption] = meta.publishInstagramFeed.mock.calls[0];
      expect(igUser).toBe('ig123');
      expect(feedUrl).toContain('/media/o2/feed/');
      expect(caption).toBe('Book your bridal trial today.\n\n#bridalmakeup #hdmakeup');
      expect(meta.publishFacebookPhoto.mock.calls[0][0]).toBe('page9');
      const last = prisma.storyBatch.update.mock.calls.at(-1)[0].data;
      expect(last.status).toBe('PUBLISHED');
      expect(last.publishedTargets).toEqual({
        IG_STORY: { ok: true, id: 'story99' },
        IG_FEED: { ok: true, id: 'feed99' },
        FB_FEED: { ok: true, id: 'fb99' },
      });
      expect(meta.sendWhatsAppMessage.mock.calls.at(-1)[2]).toContain(
        'Post live hai: Instagram story, Instagram post, Facebook post.',
      );
    });

    it('reports a partial failure without failing the rest', async () => {
      const { service, prisma, meta } = makeService({
        destinations: ['IG_FEED', 'FB_FEED'],
      });
      prisma.storyBatch.findUnique.mockResolvedValue({
        id: 'b1',
        orgId: 'org1',
        selectedOptionId: 'o2',
        waRecipient: MERCHANT,
      });
      prisma.storyOption.findUnique.mockResolvedValue(option);
      meta.publishFacebookPhoto.mockRejectedValue(new Error('Facebook Facebook photo post failed: (#200) permission'));

      await service.publishBatch('b1');

      const last = prisma.storyBatch.update.mock.calls.at(-1)[0].data;
      expect(last.status).toBe('PUBLISHED');
      expect(last.publishedTargets.FB_FEED.ok).toBe(false);
      const msg = meta.sendWhatsAppMessage.mock.calls.at(-1)[2];
      expect(msg).toContain('Post live hai: Instagram post.');
      expect(msg).toContain('Facebook post: Facebook Facebook photo post failed');
    });

    it('marks the batch failed when every destination fails', async () => {
      const { service, prisma, meta } = makeService();
      prisma.storyBatch.findUnique.mockResolvedValue({
        id: 'b1',
        orgId: 'org1',
        selectedOptionId: 'o2',
        waRecipient: MERCHANT,
      });
      prisma.storyOption.findUnique.mockResolvedValue(option);
      meta.publishInstagramStory.mockRejectedValue(new Error('Instagram publish story failed: bad token'));

      expect(await service.publishBatch('b1')).toBe(false);

      expect(prisma.storyBatch.update.mock.calls.at(-1)[0].data.status).toBe('FAILED');
      expect(meta.sendWhatsAppMessage.mock.calls.at(-1)[2]).toContain('bad token');
    });

    it('never publishes twice when the claim is lost', async () => {
      const { service, prisma, meta } = makeService();
      prisma.storyBatch.findUnique.mockResolvedValue({
        id: 'b1',
        orgId: 'org1',
        selectedOptionId: 'o2',
      });
      prisma.storyBatch.updateMany.mockResolvedValue({ count: 0 });
      expect(await service.publishBatch('b1')).toBe(false);
      expect(meta.publishInstagramStory).not.toHaveBeenCalled();
    });

    it('publishes scheduled batches that are due', async () => {
      const { service, prisma } = makeService();
      prisma.storyBatch.findMany.mockResolvedValue([{ id: 'b1' }, { id: 'b2' }]);
      const publish = jest.spyOn(service, 'publishBatch').mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      expect(await service.publishDue(NIGHT)).toBe(1);
      expect(prisma.storyBatch.findMany.mock.calls[0][0].where).toEqual({
        status: 'SCHEDULED',
        scheduledFor: { lte: NIGHT },
      });
      expect(publish).toHaveBeenCalledTimes(2);
    });
  });

  describe('media', () => {
    it('serves images only for a valid signature', async () => {
      const { service, prisma } = makeService();
      prisma.storyOption.findUnique.mockResolvedValue({
        imageData: Buffer.from('img'),
        finalImageData: null,
      });
      const url = service.mediaUrl('o1', 'draft');
      const sig = url.split('/').pop()!;

      await expect(service.getMedia('o1', 'draft', sig)).resolves.toEqual(Buffer.from('img'));
      await expect(service.getMedia('o2', 'draft', sig)).rejects.toThrow();
      await expect(service.getMedia('o1', 'final', sig)).rejects.toThrow();
      await expect(service.getMedia('o1', 'other', sig)).rejects.toThrow();

      const feedSig = service.mediaUrl('o1', 'feed').split('/').pop()!;
      await expect(service.getMedia('o1', 'feed', feedSig)).resolves.toEqual(Buffer.from('feed:img'));
    });
  });

  describe('settings', () => {
    it('needs a WhatsApp number before enabling', async () => {
      const { service, prisma } = makeService();
      prisma.storySettings.findUnique.mockResolvedValue(null);
      prisma.storySettings.upsert = jest.fn();
      await expect(service.updateSettings('org1', { enabled: true })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('validates times, option count and destinations', async () => {
      const { service, prisma } = makeService();
      prisma.storySettings.upsert = jest.fn(async ({ update }) => update);
      const saved = await service.updateSettings('org1', {
        sendTime: '8:30',
        postTime: '19.15',
        optionCount: 4,
        destinations: ['ig_feed', 'FB_FEED', 'IG_FEED'],
        nicheKeywords: [' Bridal Makeup ', 'bridal makeup', 'mehendi'],
      });
      expect(saved).toEqual({
        sendTime: '08:30',
        postTime: '19:15',
        optionCount: 4,
        destinations: ['IG_FEED', 'FB_FEED'],
        nicheKeywords: ['bridal makeup', 'mehendi'],
      });
      await expect(service.updateSettings('org1', { sendTime: '25:00' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.updateSettings('org1', { optionCount: 7 })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.updateSettings('org1', { destinations: ['TIKTOK'] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.updateSettings('org1', { destinations: [] })).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

describe('StoriesService (scheduling and own posts)', () => {
  beforeEach(() => {
    process.env.STORY_WA_PHONE_NUMBER_ID = 'platform-phone';
    process.env.STORY_WA_ACCESS_TOKEN = 'platform-token';
    process.env.STORY_MEDIA_SECRET = 'media-secret';
  });
  afterEach(() => {
    for (const k of ['STORY_WA_PHONE_NUMBER_ID', 'STORY_WA_ACCESS_TOKEN', 'STORY_MEDIA_SECRET']) {
      delete process.env[k];
    }
  });

  it('"Send ideas now" never replaces a scheduled or published post', async () => {
    for (const status of ['SCHEDULED', 'PUBLISHED', 'PUBLISHING', 'GENERATING']) {
      const { service, prisma, gemini } = makeService();
      prisma.storyBatch.findFirst.mockResolvedValue({ id: 'old', status });
      await expect(service.assertCanRegenerate('org1')).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.generateBatch('org1', { force: true })).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.storyBatch.delete).not.toHaveBeenCalled();
      expect(gemini.generateIdeas).not.toHaveBeenCalled();
    }
    const { service, prisma } = makeService();
    prisma.storyBatch.findFirst.mockResolvedValue({ id: 'old', status: 'AWAITING_PICK' });
    await expect(service.assertCanRegenerate('org1')).resolves.toBeUndefined();
  });

  it('keeps the catalog item an idea promotes, but only a real one', async () => {
    const { service, prisma, gemini } = makeService();
    prisma.offering.findMany.mockResolvedValue([{ id: 'off1', title: 'Bridal HD', priceMin: 18000, currency: 'INR' }]);
    gemini.generateIdeas.mockImplementation(async (_ctx: any, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        title: `T${i}`,
        label: 'L',
        idea: 'I',
        caption: 'C',
        imagePrompt: 'P',
        seedKeyword: 's',
        offeringId: i === 0 ? 'off1' : 'made-up',
      })),
    );
    await service.generateBatch('org1');
    const created = prisma.storyOption.create.mock.calls.map((c: any) => c[0].data.offeringId);
    expect(created[0]).toBe('off1');
    expect(created.slice(1).every((id: any) => id === null)).toBe(true);
    expect(gemini.generateIdeas.mock.calls[0][0].products[0].id).toBe('off1');
  });

  it('writes ideas in the tone and for the audience from business setup', async () => {
    const { service, prisma, gemini } = makeService();
    prisma.businessProfile.findUnique.mockResolvedValue({
      industry: 'BRIDAL_MAKEUP',
      description: 'Bridal makeup in Patna',
      tone: 'playful',
      language: 'hinglish',
      audience: 'Brides in Bihar',
    });
    await service.generateBatch('org1');
    expect(gemini.generateIdeas.mock.calls[0][0].persona).toEqual({
      tone: 'playful',
      language: 'hinglish',
      audience: 'Brides in Bihar',
    });
    expect(gemini.generateIdeas.mock.calls[0][0].description).toBe('Bridal makeup in Patna');
  });

  describe('reminders', () => {
    const batch = (over: any = {}) => ({
      id: 'b1',
      forDate: '2026-09-28',
      status: 'AWAITING_PICK',
      waRecipient: MERCHANT,
      org: { name: 'Glow Bride', timezone: 'Asia/Kolkata', storySettings: { postTime: '19:00' } },
      ...over,
    });

    it('nudges once, two hours before the posting time', async () => {
      const { service, prisma, meta } = makeService();
      prisma.storyBatch.findMany.mockResolvedValue([batch()]);
      // 17:30 IST: inside the window.
      expect(await service.remindUnpicked(new Date('2026-09-28T12:00:00Z'))).toBe(1);
      expect(prisma.storyBatch.updateMany).toHaveBeenCalledWith({
        where: { id: 'b1', reminderSentAt: null },
        data: { reminderSentAt: expect.any(Date) },
      });
      expect(meta.sendWhatsAppMessage.mock.calls[0][2]).toContain('abhi chuni nahi gayi');

      // Too early, and after the posting time: nothing.
      meta.sendWhatsAppMessage.mockClear();
      expect(await service.remindUnpicked(new Date('2026-09-28T10:00:00Z'))).toBe(0);
      expect(await service.remindUnpicked(new Date('2026-09-28T14:00:00Z'))).toBe(0);
      expect(meta.sendWhatsAppMessage).not.toHaveBeenCalled();
    });

    it('uses the template when the seller never opened the ideas', async () => {
      const { service, prisma, meta } = makeService();
      prisma.storyBatch.findMany.mockResolvedValue([batch({ status: 'NOTIFIED' })]);
      await service.remindUnpicked(new Date('2026-09-28T12:00:00Z'));
      expect(meta.sendWhatsAppMessage).not.toHaveBeenCalled();
      expect(meta.sendWhatsAppTemplate.mock.calls[0][4][1].parameters[0].payload).toBe('STORY_SHOW_b1');
    });

    it('does not remind twice when another tick claimed it', async () => {
      const { service, prisma, meta } = makeService();
      prisma.storyBatch.findMany.mockResolvedValue([batch()]);
      prisma.storyBatch.updateMany.mockResolvedValue({ count: 0 });
      expect(await service.remindUnpicked(new Date('2026-09-28T12:00:00Z'))).toBe(0);
      expect(meta.sendWhatsAppMessage).not.toHaveBeenCalled();
    });
  });

  describe("the seller's own photo", () => {
    it('recognises a photo only from a seller number', async () => {
      const { service, prisma } = makeService();
      prisma.storySettings.findFirst = jest.fn().mockResolvedValue({ orgId: 'org1' });
      const photo = { from: MERCHANT, type: 'image', image: { id: 'media1' } };
      expect(await service.isStoryReply(photo, 'platform-phone')).toBe(true);
      expect(await service.isStoryReply(photo, 'some-merchant-number')).toBe(false);
      prisma.storySettings.findFirst.mockResolvedValue(null);
      expect(await service.isStoryReply(photo, 'platform-phone')).toBe(false);
    });

    it('turns a WhatsApp photo into a post with Post this / Edit', async () => {
      const { service, prisma, meta, gemini } = makeService();
      prisma.storySettings.findFirst = jest.fn().mockResolvedValue({ orgId: 'org1' });
      prisma.storyOption.create.mockImplementation(async ({ data }: any) => ({ id: 'own1', ...data }));
      prisma.offering.findMany.mockResolvedValue([{ id: 'off1', title: 'Red lehenga' }]);

      await service.handleWhatsAppReply({
        from: MERCHANT,
        type: 'image',
        image: { id: 'media1', caption: 'Naya lehenga aa gaya!' },
      });

      expect(meta.downloadWhatsAppMedia).toHaveBeenCalledWith('media1', 'platform-token');
      expect(gemini.describeOwnPhoto.mock.calls[0][1].sellerCaption).toBe('Naya lehenga aa gaya!');
      expect(prisma.storyBatch.create.mock.calls[0][0].data).toMatchObject({
        kind: 'OWN',
        status: 'AWAITING_PICK',
        waRecipient: MERCHANT,
      });
      const option = prisma.storyOption.create.mock.calls[0][0].data;
      expect(option).toMatchObject({ source: 'OWN', offeringId: 'off1', caption: 'Naya lehenga aa gaya!' });
      expect(Buffer.from(option.imageData).toString()).toBe('padded:photo');
      expect(meta.sendWhatsAppImageButtons.mock.calls[0][4][0].id).toBe('STORY_POST_b1_1');
    });

    it('schedules an uploaded photo straight away', async () => {
      const { service, prisma } = makeService();
      prisma.storyOption.create.mockImplementation(async ({ data }: any) => ({ id: 'own1', ...data }));
      const at = '2026-09-30T13:30:00.000Z';
      await service.uploadOwnPost(
        'org1',
        { image: `data:image/jpeg;base64,${Buffer.from('photo').toString('base64')}`, at },
        MORNING,
      );
      expect(prisma.storyBatch.create.mock.calls[0][0].data.forDate).toBe('2026-09-30');
      expect(prisma.storyBatch.updateMany.mock.calls[0][0].data).toMatchObject({
        status: 'SCHEDULED',
        selectedOptionId: 'own1',
        scheduledFor: new Date(at),
      });
    });

    it('posts the seller photo without AI lettering', async () => {
      const { service, prisma, gemini } = makeService();
      prisma.storyOption.findUnique.mockResolvedValue({
        id: 'own1',
        title: 'New lehenga',
        caption: 'Naya lehenga',
        seedKeyword: 'bridal lehenga',
        source: 'OWN',
        offeringId: null,
        imageData: Buffer.from('padded'),
        batch: { trendKeywords: [] },
      });
      await service.publishOption('org1', 'own1');
      expect(gemini.addTextToImage).not.toHaveBeenCalled();
      expect(Buffer.from(prisma.storyOption.update.mock.calls[0][0].data.finalImageData).toString()).toBe('padded');
    });
  });

  it('remembers each published post and its item for the comment replies', async () => {
    const { service, prisma } = makeService({ destinations: ['IG_FEED', 'FB_FEED'] });
    prisma.storyOption.findUnique.mockResolvedValue({
      id: 'o2',
      title: 'Bridal glow',
      caption: 'Book now',
      seedKeyword: 'hd bridal makeup',
      source: 'AI',
      offeringId: 'off1',
      imageData: Buffer.from('draft'),
      batch: { trendKeywords: [] },
    });
    await service.publishOption('org1', 'o2');
    const saved = prisma.socialPost.upsert.mock.calls.map((c: any) => c[0].create);
    expect(saved.map((s: any) => [s.postId, s.platform, s.source])).toEqual([
      ['feed99', 'INSTAGRAM', 'DAILY_POST'],
      ['fb99', 'FACEBOOK', 'DAILY_POST'],
    ]);
    expect(saved[0].caption).toContain('Book now');
    expect(prisma.postOfferingLink.upsert.mock.calls[0][0].create).toMatchObject({
      postId: 'feed99',
      offeringId: 'off1',
      status: 'SELLER_CONFIRMED',
    });
  });

  describe('dashboard', () => {
    const dashBatch = (over: any = {}) => ({
      id: 'b1',
      orgId: 'org1',
      forDate: '2026-09-28',
      status: 'AWAITING_PICK',
      options: [{ id: 'o2', imageData: Buffer.from('draft') }],
      ...over,
    });

    it('schedules for the posting time, or says the time has passed', async () => {
      const { service, prisma } = makeService();
      prisma.storyBatch.findFirst.mockResolvedValue(dashBatch());
      await expect(service.pickFromDashboard('org1', 'b1', 2, {}, MORNING)).resolves.toEqual({
        status: 'SCHEDULED',
        scheduledFor: new Date('2026-09-28T13:30:00Z'),
      });
      await expect(service.pickFromDashboard('org1', 'b1', 2, {}, NIGHT)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.pickFromDashboard('org1', 'b1', 2, { when: 'tomorrow' }, NIGHT)).resolves.toEqual({
        status: 'SCHEDULED',
        scheduledFor: new Date('2026-09-29T13:30:00Z'),
      });
    });

    it('accepts a custom time within 30 days', async () => {
      const { service, prisma } = makeService();
      prisma.storyBatch.findFirst.mockResolvedValue(dashBatch());
      const at = '2026-10-02T05:00:00.000Z';
      await expect(service.pickFromDashboard('org1', 'b1', 2, { at }, MORNING)).resolves.toMatchObject({
        scheduledFor: new Date(at),
      });
      await expect(
        service.pickFromDashboard('org1', 'b1', 2, { at: '2026-12-31T05:00:00Z' }, MORNING),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("refuses another workspace's post", async () => {
      const { service, prisma } = makeService();
      prisma.storyBatch.findFirst.mockResolvedValue(null);
      await expect(service.cancelFromDashboard('org2', 'b1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cancels only a scheduled post', async () => {
      const { service, prisma } = makeService();
      prisma.storyBatch.findFirst.mockResolvedValue(dashBatch({ status: 'SCHEDULED' }));
      await expect(service.cancelFromDashboard('org1', 'b1')).resolves.toEqual({ status: 'AWAITING_PICK' });
      prisma.storyBatch.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.cancelFromDashboard('org1', 'b1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

describe('scheduling helpers', () => {
  it('nextDate crosses month ends', () => {
    expect(nextDate('2026-09-30')).toBe('2026-10-01');
    expect(nextDate('2026-12-31')).toBe('2027-01-01');
  });

  it('decodeImage takes a data URL or bare base64, and refuses anything else', () => {
    const b64 = Buffer.from('img').toString('base64');
    expect(decodeImage(`data:image/png;base64,${b64}`).toString()).toBe('img');
    expect(decodeImage(b64).toString()).toBe('img');
    expect(() => decodeImage('data:text/html;base64,PGgxPg==')).toThrow(BadRequestException);
    expect(() => decodeImage('')).toThrow(BadRequestException);
  });

  it('parseScheduleTime wants a time a few minutes to 30 days ahead', () => {
    expect(parseScheduleTime('2026-09-28T06:00:00Z', MORNING).toISOString()).toBe('2026-09-28T06:00:00.000Z');
    expect(() => parseScheduleTime('2026-09-28T04:31:00Z', MORNING)).toThrow(BadRequestException);
    expect(() => parseScheduleTime('soon', MORNING)).toThrow(BadRequestException);
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

describe('time helpers', () => {
  it('localDate uses the org timezone', () => {
    const lateUtc = new Date('2026-09-25T20:00:00Z');
    expect(localDate('Asia/Kolkata', lateUtc)).toBe('2026-09-26');
    expect(localDate('UTC', lateUtc)).toBe('2026-09-25');
    expect(localDate('Not/AZone', lateUtc)).toBe('2026-09-26');
  });

  it('localTime and zonedDateTime agree for IST and for a DST zone', () => {
    expect(localTime('Asia/Kolkata', MORNING)).toBe('10:00');
    expect(zonedDateTime('2026-09-28', '19:00', 'Asia/Kolkata').toISOString()).toBe('2026-09-28T13:30:00.000Z');
    expect(zonedDateTime('2026-07-01', '09:00', 'Europe/London').toISOString()).toBe('2026-07-01T08:00:00.000Z');
  });

  it('normalizeTime accepts common formats', () => {
    expect(normalizeTime('9:05')).toBe('09:05');
    expect(normalizeTime('21.30')).toBe('21:30');
    expect(normalizeTime('24:00')).toBeNull();
    expect(normalizeTime('noon')).toBeNull();
  });
});
