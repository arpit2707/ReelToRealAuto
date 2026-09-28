import { BadRequestException } from '@nestjs/common';
import {
  daysBetween,
  parseRoundPicks,
  StoriesService,
} from './stories.service';
import { MediaStore } from './media-store';
import {
  brandImageStyle,
  brandKitLines,
  buildIdeasPrompt,
} from './gemini.client';
import { reel2realSender, setChannelSender } from '../../common/wa-sender';

jest.mock('./story-image', () => ({
  toStoryJpeg: jest.fn(async (b: Buffer) =>
    Buffer.concat([Buffer.from('jpg:'), b]),
  ),
  toFeedJpeg: jest.fn(async (b: Buffer) =>
    Buffer.concat([Buffer.from('feed:'), b]),
  ),
  toPaddedStoryJpeg: jest.fn(async (b: Buffer) => b),
  overlayText: jest.fn(async () => Buffer.from('overlay')),
}));
jest.mock('./story-video', () => ({
  toReelMp4: jest.fn(async (b: Buffer) => b),
}));

const MERCHANT = '919876543210';
const MORNING = new Date('2026-09-28T04:30:00Z'); // 10:00 IST

const ENV = [
  'STORY_WA_PHONE_NUMBER_ID',
  'STORY_WA_ACCESS_TOKEN',
  'STORY_MEDIA_SECRET',
  'PUBLIC_BASE_URL',
];
beforeEach(() => {
  process.env.STORY_WA_PHONE_NUMBER_ID = 'platform-phone';
  process.env.STORY_WA_ACCESS_TOKEN = 'platform-token';
  process.env.STORY_MEDIA_SECRET = 'media-secret';
  process.env.PUBLIC_BASE_URL = 'https://reel2realbooking.in';
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

const IDEAS = [1, 2, 3, 4, 5].map((i) => ({
  id: `o${i}`,
  position: i,
  title: `T${i}`,
  label: `Trending ${i}`,
  idea: `Idea ${i}`,
  caption: `Caption ${i}`,
  imagePrompt: `Prompt ${i}`,
  seedKeyword: `seed ${i}`,
  offeringId: null,
}));

function makeService(settingsOver: any = {}, store?: any) {
  const settings = {
    orgId: 'org1',
    whatsappNumber: MERCHANT,
    keywordDatabase: 'in',
    sendTime: '09:00',
    postTime: '19:00',
    optionCount: 5,
    destinations: ['IG_STORY', 'IG_FEED'],
    nicheKeywords: ['bridal makeup'],
    flow: 'CONTEXTS',
    cadenceDays: 1,
    maxPicks: 3,
    brandColors: ['#c2185b', '#ffd700'],
    brandThemes: ['royal bridal'],
    visualStyle: 'soft studio light',
    brandDirection: null,
    contentLanguage: 'Hinglish',
    avoidTopics: [],
    ...settingsOver,
  };
  let created = 0;
  const prisma: any = {
    storySettings: {
      findUnique: jest.fn().mockResolvedValue(settings),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn(async ({ update }) => ({ ...settings, ...update })),
    },
    organization: {
      findUnique: jest
        .fn()
        .mockResolvedValue({
          id: 'org1',
          name: 'Glow Bride',
          timezone: 'Asia/Kolkata',
        }),
    },
    businessProfile: {
      findUnique: jest
        .fn()
        .mockResolvedValue({
          industry: 'BRIDAL_MAKEUP',
          description: 'Bridal makeup in Patna',
        }),
    },
    channel: {
      findFirst: jest.fn(async ({ where }) =>
        where.platform === 'INSTAGRAM'
          ? {
              id: 'ch1',
              channelIdentifier: 'ig123',
              accessTokenEncrypted: 'enc',
            }
          : null,
      ),
    },
    offering: { findMany: jest.fn().mockResolvedValue([]) },
    pageProfile: { findFirst: jest.fn().mockResolvedValue(null) },
    socialPost: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    postOfferingLink: { upsert: jest.fn() },
    contentInsight: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(async ({ create }) => create),
    },
    storyBatch: {
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }) => ({
        id: data.kind === 'IDEA' ? `post${++created}` : 'r1',
        ...data,
      })),
      update: jest.fn(async ({ data }) => ({ id: 'r1', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn(),
    },
    storyOption: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      create: jest.fn(async ({ data }) => ({
        id: `opt-${data.batchId}`,
        revision: 0,
        ...data,
      })),
      update: jest.fn(async ({ data }) => data),
    },
  };
  const crypto: any = { decrypt: jest.fn().mockReturnValue('page-token') };
  const meta: any = {
    sendWhatsAppTemplate: jest.fn().mockResolvedValue(true),
    sendWhatsAppMessage: jest.fn().mockResolvedValue(true),
    sendWhatsAppList: jest.fn().mockResolvedValue(true),
    sendWhatsAppImage: jest.fn().mockResolvedValue(true),
    sendWhatsAppImageButtons: jest.fn().mockResolvedValue(true),
    sendInteractiveButtonMessage: jest.fn().mockResolvedValue(true),
    publishInstagramStory: jest.fn().mockResolvedValue('story1'),
    publishInstagramFeed: jest.fn().mockResolvedValue('feed1'),
    publishFacebookPhoto: jest.fn().mockResolvedValue('fb1'),
  };
  const gemini: any = {
    isConfigured: () => true,
    trendKeywords: jest.fn().mockResolvedValue(['hd bridal makeup']),
    generateIdeas: jest.fn(async (_ctx: any, count: number) =>
      IDEAS.slice(0, count).map((i) => ({ ...i, id: undefined, position: undefined })),
    ),
    generateImage: jest.fn().mockResolvedValue(Buffer.from('png')),
    refinePost: jest.fn(async (idea: any, ctx: any) => ({
      title: `${idea.title}!`,
      caption: `${idea.caption} (${ctx.note})`,
      imagePrompt: `${idea.imagePrompt} + ${ctx.note}`,
    })),
    analyzePosts: jest
      .fn()
      .mockResolvedValue({
        summary: 'Reels of brides win.',
        topTopics: ['brides'],
        weakTopics: [],
      }),
    suggestBrandKit: jest
      .fn()
      .mockResolvedValue({
        themes: ['bridal'],
        colors: ['#aa0000'],
        visualStyle: 's',
        language: 'Hinglish',
        direction: 'd',
      }),
    addTextToImage: jest.fn().mockResolvedValue(Buffer.from('lettered')),
  };
  const keywords: any = {
    apifyHashtags: jest.fn().mockResolvedValue([]),
    research: jest
      .fn()
      .mockResolvedValue({
        keywords: ['bridal makeup'],
        hashtags: ['#bridalmakeup'],
      }),
  };
  const media = store || new MediaStore();
  const service = new StoriesService(
    prisma,
    crypto,
    meta,
    gemini,
    keywords,
    media,
  );
  return { service, prisma, meta, gemini, keywords, settings };
}

const say = (body: string) => ({
  from: MERCHANT,
  type: 'text',
  text: { body },
});
const round = (over: any = {}) => ({
  id: 'r1',
  orgId: 'org1',
  kind: 'ROUND',
  forDate: '2026-09-28',
  status: 'AWAITING_PICK',
  waRecipient: MERCHANT,
  trendKeywords: ['hd bridal makeup'],
  options: IDEAS,
  ...over,
});

describe('parseRoundPicks', () => {
  it.each([
    ['1,3', [1, 3]],
    ['1, 3', [1, 3]],
    ['1 aur 3', [1, 3]],
    ['2', [2]],
    ['idea 4', [4]],
    ['mujhe 2 chahiye', [2]],
    ['sab', [1, 2, 3, 4, 5]],
  ])('%s picks %j', (text, positions) => {
    expect(parseRoundPicks(text, 5).map((p) => p.position)).toEqual(positions);
  });

  it('keeps what the seller added to each pick', () => {
    expect(parseRoundPicks('2 red lehenga ke saath, 4', 5)).toEqual([
      { position: 2, note: 'red lehenga ke saath' },
      { position: 4, note: null },
    ]);
    expect(parseRoundPicks('3 me mehendi bhi dikhao', 5)).toEqual([
      { position: 3, note: 'mehendi bhi dikhao' },
    ]);
  });

  it('does not read a number inside a note as another pick', () => {
    expect(parseRoundPicks('2 me 5 log dikhao', 5)).toEqual([
      { position: 2, note: '5 log dikhao' },
    ]);
  });

  it('ignores chat that only mentions a number', () => {
    expect(parseRoundPicks('kal 5 baje call karna', 5)).toEqual([]);
    expect(parseRoundPicks('hello', 5)).toEqual([]);
    expect(parseRoundPicks('7', 5)).toEqual([]);
  });
});

describe('text-first rounds', () => {
  it('sends the ideas as text: no images are drawn until the seller picks', async () => {
    const { service, prisma, gemini, meta } = makeService();
    await service.generateBatch('org1');
    expect(prisma.storyBatch.create.mock.calls[0][0].data.kind).toBe('ROUND');
    expect(gemini.generateImage).not.toHaveBeenCalled();
    expect(prisma.storyOption.create).toHaveBeenCalledTimes(5);
    expect(
      prisma.storyOption.create.mock.calls[0][0].data.imageData,
    ).toBeUndefined();
    expect(meta.sendWhatsAppTemplate).toHaveBeenCalled();
    // The brand kit reaches the ideas prompt.
    expect(gemini.generateIdeas.mock.calls[0][0].brandKit).toMatchObject({
      colors: ['#c2185b', '#ffd700'],
    });
  });

  it('"Show ideas" lists the ideas as text and a one-tap list', async () => {
    const { service, prisma, meta } = makeService();
    prisma.storyBatch.findUnique.mockResolvedValue(
      round({ status: 'NOTIFIED' }),
    );
    await service.showOptions('r1', MERCHANT);
    const text = meta.sendWhatsAppMessage.mock.calls[0][2];
    expect(text).toContain('*1. T1*');
    expect(text).toContain('3 tak');
    expect(meta.sendWhatsAppList.mock.calls[0][4][1].id).toBe('STORY_CTX_r1_2');
    expect(meta.sendWhatsAppImageButtons).not.toHaveBeenCalled();
    expect(prisma.storyBatch.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'AWAITING_PICK' } }),
    );
  });

  it('"1,3 ..." makes one post per pick, with the note, in the brand look, and offers Post / Story / Edit', async () => {
    const { service, prisma, meta, gemini } = makeService();
    prisma.storyBatch.findFirst.mockImplementation(async ({ where }: any) =>
      where.kind === 'ROUND' ? { id: 'r1' } : null,
    );
    prisma.storyBatch.findUnique.mockResolvedValue(round());
    expect(
      await service.isStoryReply(
        say('1, 3 red lehenga ke saath'),
        'platform-phone',
      ),
    ).toBe(true);
    await service.handleWhatsAppReply(say('1, 3 red lehenga ke saath'));

    expect(prisma.storyBatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'r1' }),
        data: { status: 'PICKED' },
      }),
    );
    const posts = prisma.storyBatch.create.mock.calls.map(
      (c: any) => c[0].data,
    );
    expect(
      posts.map((p: any) => [p.kind, p.parentBatchId, p.sellerNote]),
    ).toEqual([
      ['IDEA', 'r1', null],
      ['IDEA', 'r1', 'red lehenga ke saath'],
    ]);
    expect(gemini.refinePost).toHaveBeenCalledTimes(1);
    expect(gemini.generateImage.mock.calls[1][0]).toContain(
      'red lehenga ke saath',
    );
    expect(gemini.generateImage.mock.calls[0][0]).toContain('#c2185b');
    const buttons = meta.sendWhatsAppImageButtons.mock.calls[0][4];
    expect(buttons.map((b: any) => b.title)).toEqual(['Post', 'Story', 'Edit']);
    expect(buttons[0].id).toBe('STORY_ASPOST_post1_1');
  });

  it('caps a round at maxPicks and says so', async () => {
    const { service, prisma, meta } = makeService({ maxPicks: 2 });
    prisma.storyBatch.findUnique.mockResolvedValue(round());
    const made = await service.pickContexts('r1', parseRoundPicks('sab', 5), {
      from: MERCHANT,
    });
    expect(made).toHaveLength(2);
    expect(meta.sendWhatsAppMessage.mock.calls[0][2]).toContain('2 tak');
  });

  it('draws nothing twice when the round was already picked', async () => {
    const { service, prisma, gemini } = makeService();
    prisma.storyBatch.findUnique.mockResolvedValue(round());
    prisma.storyBatch.updateMany.mockResolvedValue({ count: 0 });
    expect(
      await service.pickContexts('r1', [{ position: 1, note: null }], {
        from: MERCHANT,
      }),
    ).toEqual([]);
    expect(gemini.generateImage).not.toHaveBeenCalled();
  });

  it('only the seller the round was sent to can pick from it', async () => {
    const { service, prisma, gemini } = makeService();
    prisma.storyBatch.findUnique.mockResolvedValue(round());
    expect(
      await service.pickContexts('r1', [{ position: 1, note: null }], {
        from: '910000000000',
      }),
    ).toEqual([]);
    expect(gemini.generateImage).not.toHaveBeenCalled();
  });

  it('"skip" closes the round', async () => {
    const { service, prisma, meta } = makeService();
    prisma.storyBatch.findFirst.mockImplementation(async ({ where }: any) =>
      where.kind === 'ROUND' ? { id: 'r1' } : null,
    );
    await service.handleWhatsAppReply(say('aaj nahi'));
    expect(prisma.storyBatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'SKIPPED' } }),
    );
    expect(meta.sendWhatsAppMessage.mock.calls[0][2]).toContain(
      'aaj koi post nahi',
    );
  });

  it('"Story" posts that one post only as a story; "Post" only to the feed destinations', async () => {
    jest.useFakeTimers({
      now: MORNING,
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'queueMicrotask'],
    });
    try {
      const { service, prisma } = makeService();
      const post = {
        id: 'post1',
        orgId: 'org1',
        kind: 'IDEA',
        forDate: '2026-09-28',
        status: 'AWAITING_PICK',
        waRecipient: MERCHANT,
      };
      prisma.storyBatch.findUnique.mockImplementation(
        async ({ include }: any) =>
          include
            ? { ...post, destinations: ['IG_STORY'], options: [{ id: 'opt1' }] }
            : post,
      );
      await service.handleWhatsAppReply({
        from: MERCHANT,
        type: 'interactive',
        interactive: { button_reply: { id: 'STORY_ASSTORY_post1_1' } },
      });
      expect(prisma.storyBatch.update).toHaveBeenCalledWith({
        where: { id: 'post1' },
        data: { destinations: ['IG_STORY'] },
      });
      expect(prisma.storyBatch.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'SCHEDULED',
            selectedOptionId: 'opt1',
          }),
        }),
      );

      prisma.storyBatch.update.mockClear();
      await service.approveAs('post1', 1, MERCHANT, 'POST');
      expect(prisma.storyBatch.update).toHaveBeenCalledWith({
        where: { id: 'post1' },
        data: { destinations: ['IG_FEED'] },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('publishes only where that post was approved for', async () => {
    const { service, prisma, meta } = makeService();
    prisma.storyOption.findUnique.mockResolvedValue({
      id: 'opt1',
      title: 'T1',
      caption: 'C',
      seedKeyword: 'seed',
      hashtags: ['#a'],
      keywords: [],
      source: 'AI',
      imageData: Buffer.from('img'),
      batch: { orgId: 'org1', trendKeywords: [] },
    });
    const r = await service.publishOption('org1', 'opt1', ['IG_STORY']);
    expect(Object.keys(r.targets)).toEqual(['IG_STORY']);
    expect(meta.publishInstagramFeed).not.toHaveBeenCalled();
  });

  it('the dashboard can pick ideas too', async () => {
    const { service, prisma } = makeService();
    prisma.storyBatch.findFirst.mockResolvedValue({
      id: 'r1',
      status: 'AWAITING_PICK',
    });
    const spy = jest.spyOn(service, 'pickContexts').mockResolvedValue([]);
    await expect(
      service.pickContextsFromDashboard('org1', 'r1', [
        { position: 2, note: ' pink ' },
      ]),
    ).resolves.toEqual({
      accepted: true,
      picks: 1,
    });
    await new Promise((r) => setImmediate(r));
    expect(spy).toHaveBeenCalledWith('r1', [{ position: 2, note: 'pink' }], {
      orgId: 'org1',
    });
    await expect(
      service.pickContextsFromDashboard('org1', 'r1', []),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('cadence', () => {
  it('counts whole days', () => {
    expect(daysBetween('2026-09-28', '2026-10-01')).toBe(3);
    expect(daysBetween('2026-09-28', '2026-09-28')).toBe(0);
  });

  it('every third day: skips while the last round is younger than that', async () => {
    const { service, prisma } = makeService();
    prisma.storySettings.findMany.mockResolvedValue([
      {
        orgId: 'recent',
        sendTime: '09:00',
        cadenceDays: 3,
        org: { timezone: 'Asia/Kolkata' },
      },
      {
        orgId: 'due',
        sendTime: '09:00',
        cadenceDays: 3,
        org: { timezone: 'Asia/Kolkata' },
      },
    ]);
    prisma.storyBatch.findFirst.mockImplementation(async ({ where }: any) => {
      if (where.forDate) return null; // nothing today
      return {
        forDate: where.orgId === 'recent' ? '2026-09-26' : '2026-09-25',
      };
    });
    const generate = jest
      .spyOn(service, 'generateBatch')
      .mockResolvedValue({} as any);
    await service.runDaily(MORNING);
    expect(generate.mock.calls.map((c) => c[0])).toEqual(['due']);
  });
});

describe('settings: brand kit', () => {
  it('saves the brand kit and checks colours, cadence and picks', async () => {
    const { service, prisma } = makeService();
    await service.updateSettings('org1', {
      brandColors: ['#C2185B', ' #ffd700 '],
      brandThemes: ['royal bridal', 'royal bridal', ''],
      contentLanguage: ' Hinglish ',
      cadenceDays: 3,
      maxPicks: 2,
      flow: 'contexts',
    });
    expect(prisma.storySettings.upsert.mock.calls[0][0].update).toMatchObject({
      brandColors: ['#c2185b', '#ffd700'],
      brandThemes: ['royal bridal'],
      contentLanguage: 'Hinglish',
      cadenceDays: 3,
      maxPicks: 2,
      flow: 'CONTEXTS',
    });
    await expect(
      service.updateSettings('org1', { brandColors: ['red'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.updateSettings('org1', { cadenceDays: 9 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.updateSettings('org1', { maxPicks: 0 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('puts the brand kit in prompts', () => {
    const kit = {
      colors: ['#c2185b'],
      visualStyle: 'soft light',
      language: 'Hinglish',
      avoid: ['price'],
    };
    expect(brandKitLines(kit)).toContain(
      'Brand colours (use them in every image): #c2185b',
    );
    expect(brandKitLines(kit)).toContain('Never use or mention: price');
    expect(brandImageStyle(kit)).toBe(
      '\nBrand look: colour palette #c2185b; soft light.',
    );
    expect(brandImageStyle(null)).toBe('');
    const prompt = buildIdeasPrompt(
      {
        brandName: 'Glow',
        products: [],
        recentTitles: [],
        forDate: '2026-09-28',
        brandKit: kit,
        insights: {
          summary: 'Brides win.',
          topTopics: ['brides'],
          weakTopics: ['offers'],
        },
        pastPosts: ['Old post about mehendi'],
      },
      5,
    );
    expect(prompt).toContain(
      'What worked on this page before: Brides win. Best topics: brides.',
    );
    expect(prompt).toContain('- Old post about mehendi');
  });
});

describe('past-post insights', () => {
  const posts = [1, 2, 3].map((i) => ({
    caption: `Post ${i}`,
    likes: i,
    commentsCount: 0,
    postedAt: null,
  }));

  it('keeps a summary younger than a week', async () => {
    const { service, prisma, gemini } = makeService();
    prisma.contentInsight.findUnique.mockResolvedValue({
      summary: 'x',
      analyzedAt: new Date(MORNING.getTime() - 86_400_000),
    });
    await service.ensureInsights('org1', 'Glow', MORNING);
    expect(gemini.analyzePosts).not.toHaveBeenCalled();
  });

  it('re-reads the page weekly once it has a few posts', async () => {
    const { service, prisma, gemini } = makeService();
    prisma.socialPost.findMany.mockResolvedValue(posts);
    const saved = await service.ensureInsights('org1', 'Glow', MORNING);
    expect(gemini.analyzePosts).toHaveBeenCalledWith(
      'Glow',
      expect.arrayContaining([
        expect.objectContaining({ caption: 'Post 1', likes: 1 }),
      ]),
    );
    expect(saved).toMatchObject({
      orgId: 'org1',
      summary: 'Reels of brides win.',
      postsAnalyzed: 3,
    });
  });

  it('waits for at least three posts', async () => {
    const { service, prisma, gemini } = makeService();
    prisma.socialPost.findMany.mockResolvedValue(posts.slice(0, 2));
    expect(await service.ensureInsights('org1', 'Glow', MORNING)).toBeNull();
    expect(gemini.analyzePosts).not.toHaveBeenCalled();
  });
});

describe('object storage', () => {
  const store = () => {
    const objects = new Map<string, Buffer>();
    return {
      objects,
      isConfigured: () => true,
      put: jest.fn(async (k: string, d: Buffer) => void objects.set(k, d)),
      get: jest.fn(async (k: string) => objects.get(k)!),
    };
  };

  it('stores drawn images in the bucket, not the database, and serves them back', async () => {
    const s = store();
    const { service, prisma } = makeService({}, s);
    prisma.storyBatch.findUnique.mockResolvedValue(round());
    await service.pickContexts('r1', [{ position: 1, note: null }], {
      from: MERCHANT,
    });
    const data = prisma.storyOption.create.mock.calls[0][0].data;
    expect(data.imageKey).toMatch(/^posts\/\d{4}-\d{2}\/[0-9a-f-]+\.jpg$/);
    expect(data.imageData).toBeNull();
    expect(s.put).toHaveBeenCalledWith(
      data.imageKey,
      Buffer.from('jpg:png'),
      'image/jpeg',
    );

    prisma.storyOption.findUnique.mockResolvedValue({
      imageKey: data.imageKey,
      imageData: null,
    });
    const url = service.mediaUrl('opt1', 'draft');
    const signature = url.split('/').pop()!;
    await expect(service.getMedia('opt1', 'draft', signature)).resolves.toEqual(
      Buffer.from('jpg:png'),
    );
  });

  it('falls back to the database when the upload fails', async () => {
    const s = store();
    s.put.mockRejectedValue(new Error('403'));
    const { service, prisma } = makeService({}, s);
    prisma.storyBatch.findUnique.mockResolvedValue(round());
    await service.pickContexts('r1', [{ position: 1, note: null }], {
      from: MERCHANT,
    });
    const data = prisma.storyOption.create.mock.calls[0][0].data;
    expect(data.imageKey).toBeNull();
    expect(Buffer.from(data.imageData)).toEqual(Buffer.from('jpg:png'));
  });
});

describe('WhatsApp sender from a connected channel', () => {
  afterEach(() => setChannelSender(null));

  it('uses the channel token when only the phone number id is configured', async () => {
    delete process.env.STORY_WA_ACCESS_TOKEN;
    const { service, prisma } = makeService();
    prisma.channel.findFirst.mockResolvedValue({ accessTokenEncrypted: 'enc' });
    expect(reel2realSender()).toBeNull();
    await service.loadChannelSender();
    expect(prisma.channel.findFirst.mock.calls[0][0].where).toMatchObject({
      platform: 'WHATSAPP',
      channelIdentifier: 'platform-phone',
    });
    expect(reel2realSender()).toEqual({
      phoneNumberId: 'platform-phone',
      accessToken: 'page-token',
    });
  });
});
