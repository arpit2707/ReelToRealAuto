import { PostTaggingService } from './post-tagging.service';
import { WebhookService } from '../webhook/webhook.service';

const SELLER = '919876543210';
const NOW = new Date('2026-09-30T06:00:00Z');
const HOUR = 60 * 60 * 1000;

function make(over: { links?: any; asked?: number; gemini?: any } = {}) {
  const prisma: any = {
    socialPost: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    channel: {
      findFirst: jest.fn().mockResolvedValue({ id: 'ch1', platform: 'INSTAGRAM' }),
      findMany: jest.fn().mockResolvedValue([{ id: 'ch1', platform: 'INSTAGRAM' }]),
    },
    businessProfile: {
      findUnique: jest.fn(async ({ select }: any) =>
        select?.alertPhone ? { alertPhone: null } : { autoTagPosts: true },
      ),
      findMany: jest.fn().mockResolvedValue([{ orgId: 'org1' }]),
    },
    storySettings: { findUnique: jest.fn().mockResolvedValue({ whatsappNumber: SELLER }) },
    offering: {
      count: jest.fn().mockResolvedValue(3),
      findMany: jest.fn().mockResolvedValue([{ id: 'off1' }]),
      findFirst: jest.fn().mockResolvedValue({
        title: 'Kashmiri Silk Saree',
        priceMode: 'FIXED',
        priceMin: 2499,
        priceMax: null,
        currency: 'INR',
      }),
    },
    postOfferingLink: {
      count: jest.fn(async ({ where }: any) => (where.askedAt?.gt ? (over.asked ?? 0) : 0)),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn(async ({ data }: any) => ({ id: `link-${data.offeringId}`, ...data })),
      findFirst: jest.fn(async ({ where }: any) => ({ id: where.id, orgId: where.orgId })),
      findUnique: jest.fn(),
      ...over.links,
    },
    postTagRun: { findFirst: jest.fn() },
  };
  const post = (ageMs: number, extra: any = {}) => ({
    id: `media-${ageMs}`,
    text: 'Naya Kashmiri silk collection aa gaya',
    mediaUrl: 'https://cdn.ig/photo.jpg',
    mediaType: 'IMAGE',
    permalink: 'https://ig/p/1',
    createdAt: new Date(Date.now() - ageMs).toISOString(),
    likes: 0,
    commentsCount: 0,
    ...extra,
  });
  const posts: any = { getPost: jest.fn(), listPosts: jest.fn() };
  // Without Gemini the caption match is the suggestion (confidence 0.55).
  const gemini: any = over.gemini ?? { isConfigured: () => false };
  const context: any = { search: jest.fn().mockResolvedValue([{ id: 'off1' }]) };
  const meta: any = {
    sendWhatsAppImageButtons: jest.fn().mockResolvedValue(true),
    sendInteractiveButtonMessage: jest.fn().mockResolvedValue(true),
    sendWhatsAppTemplate: jest.fn().mockResolvedValue(true),
    sendWhatsAppMessage: jest.fn().mockResolvedValue(true),
  };
  const service = new PostTaggingService(prisma, posts, gemini, context, meta);
  return { service, prisma, posts, meta, post };
}

describe('post tag confirmation on WhatsApp', () => {
  beforeEach(() => {
    process.env.STORY_WA_PHONE_NUMBER_ID = 'platform-phone';
    process.env.STORY_WA_ACCESS_TOKEN = 'platform-token';
  });
  afterEach(() => {
    delete process.env.STORY_WA_PHONE_NUMBER_ID;
    delete process.env.STORY_WA_ACCESS_TOKEN;
    delete process.env.POST_TAG_WA_TEMPLATE;
  });

  it('asks the seller about a fresh post, with the photo and Haan / Nahi', async () => {
    const { service, prisma, posts, meta, post } = make();
    posts.getPost.mockResolvedValue(post(2 * HOUR));
    await service.ensurePostContext('org1', 'ch1', 'media-x');

    const [, to, image, body, buttons] = meta.sendWhatsAppImageButtons.mock.calls[0];
    expect(to).toBe(SELLER);
    expect(image).toBe('https://cdn.ig/photo.jpg');
    expect(body).toContain('Kashmiri Silk Saree (₹2,499)');
    expect(body).toContain('Naya Kashmiri silk collection');
    expect(buttons).toEqual([
      { id: 'TAG_YES_link-off1', title: 'Haan, yahi hai' },
      { id: 'TAG_NO_link-off1', title: 'Nahi' },
    ]);
    expect(prisma.postOfferingLink.updateMany).toHaveBeenCalledWith({
      where: { id: 'link-off1', askedAt: null },
      data: { askedAt: expect.any(Date) },
    });
  });

  it('does not ask about old posts, or beyond the daily limit', async () => {
    const old = make();
    old.posts.getPost.mockResolvedValue(old.post(5 * 24 * HOUR));
    await old.service.ensurePostContext('org1', 'ch1', 'media-x');
    expect(old.meta.sendWhatsAppImageButtons).not.toHaveBeenCalled();

    const busy = make({ asked: 3 });
    busy.posts.getPost.mockResolvedValue(busy.post(HOUR));
    await busy.service.ensurePostContext('org1', 'ch1', 'media-x');
    expect(busy.meta.sendWhatsAppImageButtons).not.toHaveBeenCalled();
  });

  it('asks a video post as text, and falls back to the approved template outside the 24h window', async () => {
    process.env.POST_TAG_WA_TEMPLATE = 'post_tag_check';
    const { service, posts, meta, post } = make();
    meta.sendInteractiveButtonMessage.mockResolvedValue(false);
    posts.getPost.mockResolvedValue(post(HOUR, { mediaType: 'VIDEO' }));
    await service.ensurePostContext('org1', 'ch1', 'media-x');
    expect(meta.sendWhatsAppImageButtons).not.toHaveBeenCalled();
    const [, to, template, , components] = meta.sendWhatsAppTemplate.mock.calls[0];
    expect([to, template]).toEqual([SELLER, 'post_tag_check']);
    expect(components[0].parameters[0].text).toBe('Kashmiri Silk Saree (₹2,499)');
    expect(components.slice(1).map((c: any) => c.parameters[0].payload)).toEqual([
      'TAG_YES_link-off1',
      'TAG_NO_link-off1',
    ]);
  });

  it('un-marks the question when nothing could be sent, so it is not lost', async () => {
    const { service, prisma, posts, meta, post } = make();
    meta.sendWhatsAppImageButtons.mockResolvedValue(false);
    posts.getPost.mockResolvedValue(post(HOUR));
    await service.ensurePostContext('org1', 'ch1', 'media-x');
    expect(prisma.postOfferingLink.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'link-off1' },
      data: { askedAt: null },
    });
  });

  it('"Haan" confirms the tag at full confidence; "Nahi" rejects it', async () => {
    const { service, prisma, meta } = make();
    prisma.postOfferingLink.findUnique.mockResolvedValue({
      id: 'link-off1',
      orgId: 'org1',
      offering: { title: 'Kashmiri Silk Saree' },
    });
    await service.handleTagAnswer({ from: SELLER, interactive: { button_reply: { id: 'TAG_YES_link-off1' } } });
    expect(prisma.postOfferingLink.update).toHaveBeenCalledWith({
      where: { id: 'link-off1' },
      data: { status: 'SELLER_CONFIRMED' },
    });
    expect(prisma.postOfferingLink.update).toHaveBeenCalledWith({ where: { id: 'link-off1' }, data: { confidence: 1 } });
    expect(meta.sendWhatsAppMessage.mock.calls[0][2]).toContain('Kashmiri Silk Saree');

    prisma.postOfferingLink.update.mockClear();
    await service.handleTagAnswer({ from: SELLER, button: { payload: 'TAG_NO_link-off1' } });
    expect(prisma.postOfferingLink.update).toHaveBeenCalledWith({
      where: { id: 'link-off1' },
      data: { status: 'SELLER_REJECTED' },
    });
  });

  it('ignores an answer from any number other than the seller asked', async () => {
    const { service, prisma } = make();
    prisma.postOfferingLink.findUnique.mockResolvedValue({ id: 'link-off1', orgId: 'org1', offering: null });
    await service.handleTagAnswer({ from: '910000000000', interactive: { button_reply: { id: 'TAG_YES_link-off1' } } });
    expect(prisma.postOfferingLink.update).not.toHaveBeenCalled();
  });

  it('the hourly scan tags only new, unseen Instagram posts', async () => {
    const { service, prisma, posts, meta, post } = make();
    const seen = post(HOUR, { id: 'seen' });
    const fresh = post(2 * HOUR, { id: 'fresh' });
    const old = post(10 * 24 * HOUR, { id: 'old' });
    posts.listPosts.mockResolvedValue({ posts: [seen, fresh, old] });
    prisma.socialPost.findMany.mockResolvedValue([{ postId: 'seen' }]);

    await service.scanNewPosts();

    expect(prisma.socialPost.findMany.mock.calls[0][0].where.postId).toEqual({ in: ['seen', 'fresh'] });
    const tagged = prisma.postOfferingLink.create.mock.calls.map((c: any) => c[0].data.postId);
    expect(tagged).toEqual(['fresh']);
    expect(meta.sendWhatsAppImageButtons).toHaveBeenCalledTimes(1);
  });

  it('the scan skips orgs with nobody to ask', async () => {
    const { service, prisma, posts } = make();
    prisma.storySettings.findUnique.mockResolvedValue(null);
    await service.scanNewPosts(NOW);
    expect(posts.listPosts).not.toHaveBeenCalled();
  });
});

describe('WebhookService post tagging routes', () => {
  const base = () => {
    const prisma: any = {
      webhookEvent: { create: jest.fn().mockResolvedValue({}) },
      processedWebhookEvent: { create: jest.fn().mockResolvedValue({}) },
      channel: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'fbch',
          orgId: 'org1',
          accessTokenEncrypted: 'enc',
          org: { name: 'Shop' },
        }),
      },
    };
    const crypto: any = { decrypt: () => 'page-token' };
    const stories: any = { isStoryReply: jest.fn().mockResolvedValue(false), handleWhatsAppReply: jest.fn() };
    const postTagging: any = {
      isTagAnswer: jest.fn((m: any) => String(m?.interactive?.button_reply?.id || '').startsWith('TAG_')),
      handleTagAnswer: jest.fn().mockResolvedValue(undefined),
      ensurePostContext: jest.fn().mockResolvedValue(undefined),
    };
    const service = new WebhookService(prisma, crypto, {} as any, {} as any, {} as any, {} as any, stories, {} as any, postTagging);
    return { service, stories, postTagging };
  };

  it('hands a Haan / Nahi answer to post tagging, not to the stories or inbox', async () => {
    const { service, stories, postTagging } = base();
    const msg = { id: 'wamid.9', from: SELLER, interactive: { button_reply: { id: 'TAG_YES_l1' } } };
    await service.processWebhookEvent({
      object: 'whatsapp_business_account',
      entry: [{ id: 'waba', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'p' }, messages: [msg] } }] }],
    });
    expect(postTagging.handleTagAnswer).toHaveBeenCalledWith(msg);
    expect(stories.isStoryReply).not.toHaveBeenCalled();
  });

  it('tags a post the Page just published', async () => {
    const { service, postTagging } = base();
    await service.processWebhookEvent({
      object: 'page',
      entry: [
        {
          id: 'page9',
          changes: [
            {
              field: 'feed',
              value: { item: 'photo', verb: 'add', post_id: 'page9_123', from: { id: 'page9' } },
            },
          ],
        },
      ],
    });
    await new Promise((r) => setImmediate(r));
    expect(postTagging.ensurePostContext).toHaveBeenCalledWith('org1', 'fbch', 'page9_123');
  });

  it("ignores a visitor's post on the Page", async () => {
    const { service, postTagging } = base();
    await service.processWebhookEvent({
      object: 'page',
      entry: [
        {
          id: 'page9',
          changes: [{ field: 'feed', value: { item: 'status', verb: 'add', post_id: 'page9_5', from: { id: 'visitor' } } }],
        },
      ],
    });
    await new Promise((r) => setImmediate(r));
    expect(postTagging.ensurePostContext).not.toHaveBeenCalled();
  });
});
