import { BadRequestException } from '@nestjs/common';
import { DmSpotlightService, spotlightStatus } from './dm-spotlight.service';
import { ReplyContextService } from './reply-context.service';

const now = new Date('2026-10-01T10:00:00Z');
const day = 24 * 60 * 60 * 1000;

describe('spotlight status', () => {
  const row = { startsAt: null, endsAt: null, missingAt: null };
  it('explains why a post is (not) shown', () => {
    expect(spotlightStatus(row, { aiOn: true, inactiveItems: 0 }, now)).toBe('ACTIVE');
    expect(spotlightStatus(row, { aiOn: false, inactiveItems: 0 }, now)).toBe('POST_AI_OFF');
    expect(spotlightStatus({ ...row, startsAt: new Date(now.getTime() + day) }, { aiOn: true, inactiveItems: 0 }, now)).toBe(
      'SCHEDULED',
    );
    expect(spotlightStatus({ ...row, endsAt: new Date(now.getTime() - day) }, { aiOn: true, inactiveItems: 0 }, now)).toBe(
      'EXPIRED',
    );
    expect(spotlightStatus(row, { aiOn: true, inactiveItems: 1 }, now)).toBe('ITEM_INACTIVE');
    expect(spotlightStatus({ ...row, missingAt: now }, { aiOn: true, inactiveItems: 0 }, now)).toBe('POST_MISSING');
  });
});

function setup(opts: { on?: string[]; rows?: any[]; socials?: any[]; links?: any[]; getPost?: jest.Mock } = {}) {
  const socials = opts.socials || [
    { postId: 'p1', channelId: 'ch1', platform: 'INSTAGRAM', caption: 'Diwali sarees', permalink: 'https://instagram.com/p/1' },
    { postId: 'p2', channelId: 'ch1', platform: 'INSTAGRAM', caption: 'Kurtis', permalink: 'https://instagram.com/p/2' },
    { postId: 'p3', channelId: 'ch2', platform: 'INSTAGRAM', caption: 'Other page', permalink: null },
  ];
  const prisma: any = {
    channel: {
      findFirst: jest.fn(async ({ where }: any) =>
        ['ch1', 'ch2'].includes(where.id) ? { id: where.id, platform: 'INSTAGRAM' } : null,
      ),
    },
    dmSpotlight: {
      findMany: jest.fn().mockResolvedValue(opts.rows || []),
      deleteMany: jest.fn().mockReturnValue('delete'),
      createMany: jest.fn().mockReturnValue('create'),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    socialPost: {
      findMany: jest.fn(async ({ where }: any) => socials.filter((s) => where.postId.in.includes(s.postId))),
    },
    postOfferingLink: { findMany: jest.fn().mockResolvedValue(opts.links || []) },
    $transaction: jest.fn().mockResolvedValue([]),
  };
  const gate: any = {
    onPosts: jest.fn(async (_o: string, ids: string[]) => new Set(ids.filter((id) => (opts.on || ['p1', 'p2', 'p3']).includes(id)))),
  };
  const posts: any = { getPost: opts.getPost || jest.fn() };
  return { prisma, gate, svc: new DmSpotlightService(prisma, gate, posts) };
}

describe('DmSpotlightService.replace', () => {
  it('saves the list in order with labels and dates', async () => {
    const { svc, prisma } = setup();
    await svc.replace('o', 'ch1', [
      { postId: 'p2', label: ' Kurti sale ' },
      { postId: 'p1', startsAt: '2026-10-01', endsAt: '2026-10-10' },
    ]);
    const data = prisma.dmSpotlight.createMany.mock.calls[0][0].data;
    expect(data.map((d: any) => [d.postId, d.position, d.label])).toEqual([
      ['p2', 0, 'Kurti sale'],
      ['p1', 1, null],
    ]);
    expect(prisma.dmSpotlight.deleteMany).toHaveBeenCalledWith({ where: { orgId: 'o', channelId: 'ch1' } });
    expect(prisma.$transaction).toHaveBeenCalledWith(['delete', 'create']);
  });

  it('an empty list clears the Spotlight', async () => {
    const { svc, prisma } = setup();
    await svc.replace('o', 'ch1', []);
    expect(prisma.$transaction).toHaveBeenCalledWith(['delete']);
  });

  it('rejects more than 5, duplicates, another page, AI-off posts and bad dates', async () => {
    const { svc } = setup({ on: ['p1'] });
    const six = Array.from({ length: 6 }, (_, i) => ({ postId: `p${i}` }));
    await expect(svc.replace('o', 'ch1', six)).rejects.toThrow('At most 5');
    await expect(svc.replace('o', 'ch1', [{ postId: 'p1' }, { postId: 'p1' }])).rejects.toThrow('only once');
    await expect(svc.replace('o', 'ch1', [{ postId: 'p3' }])).rejects.toThrow('another page');
    await expect(svc.replace('o', 'ch1', [{ postId: 'p2' }])).rejects.toThrow('Switch the AI on');
    await expect(svc.replace('o', 'ch1', [{ postId: 'nope' }])).rejects.toThrow('not known');
    await expect(
      svc.replace('o', 'ch1', [{ postId: 'p1', startsAt: '2026-10-10', endsAt: '2026-10-01' }]),
    ).rejects.toThrow(BadRequestException);
    await expect(svc.replace('o', 'ch9', [])).rejects.toThrow('Page not found');
  });
});

describe('DmSpotlightService for plain DMs', () => {
  const rows = [
    { postId: 'p1', position: 0, label: 'Diwali sale', startsAt: null, endsAt: null, missingAt: null },
    { postId: 'p2', position: 1, label: null, startsAt: new Date(now.getTime() + day), endsAt: null, missingAt: null },
  ];
  const links = [
    { postId: 'p1', offering: { id: 'o1', title: 'Silk saree', isActive: true } },
    { postId: 'p1', offering: { id: 'o2', title: 'Old saree', isActive: false } },
  ];

  it('sends only shown posts, with active items and the permalink', async () => {
    const { svc } = setup({ rows, links });
    expect(await svc.forDm('o', 'ch1', now)).toEqual([
      {
        post_id: 'p1',
        label: 'Diwali sale',
        caption: 'Diwali sarees',
        permalink: 'https://instagram.com/p/1',
        offering_ids: ['o1'],
      },
    ]);
  });

  it('a post whose AI went off stops at once', async () => {
    const { svc } = setup({ rows, links, on: [] });
    expect(await svc.forDm('o', 'ch1', now)).toEqual([]);
    const listed = await svc.list('o', 'ch1');
    expect(listed.posts.map((p) => p.status)).toEqual(['POST_AI_OFF', 'POST_AI_OFF']);
    expect(listed.warning).toBe('none_active');
  });

  it('marks a post deleted on Meta as missing, and ignores network errors', async () => {
    const getPost = jest.fn(async (_o: string, _c: string, id: string) => {
      if (id === 'p1') throw new Error('Unsupported get request. Object with ID p1 does not exist');
      throw new Error('fetch failed');
    });
    const { svc, prisma } = setup({ rows, getPost });
    expect(await svc.checkMissing('o', 'ch1', [])).toBe(1);
    expect(prisma.dmSpotlight.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.dmSpotlight.updateMany.mock.calls[0][0]).toMatchObject({
      where: { postId: 'p1' },
      data: { missingAt: expect.any(Date) },
    });
  });

  it('clears the mark when the post is listed again', async () => {
    const { svc, prisma } = setup({ rows: [{ ...rows[0], missingAt: now }] });
    await svc.checkMissing('o', 'ch1', ['p1']);
    expect(prisma.dmSpotlight.updateMany.mock.calls[0][0].data).toEqual({ missingAt: null });
  });
});

describe('plain DM context with a Spotlight', () => {
  it('adds Spotlight items (match spotlight) and their links; a post chat does not', async () => {
    const item = { id: 'o1', type: 'PRODUCT', title: 'Silk saree', priceMode: 'FIXED', priceMin: 2499, priceMax: null, currency: 'INR' };
    const prisma: any = {
      businessProfile: { findUnique: jest.fn().mockResolvedValue({ industry: 'OTHER', offerType: 'PRODUCTS' }) },
      conversation: { findUnique: jest.fn().mockResolvedValue({ goalState: {} }) },
      pageProfile: { findFirst: jest.fn().mockResolvedValue(null) },
      socialPost: { findUnique: jest.fn().mockResolvedValue({ caption: 'Post', note: null }) },
      postOfferingLink: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      offering: {
        findMany: jest.fn(async ({ where }: any) =>
          where?.id?.in?.includes('o1') ? [{ ...item, variants: [], components: [] }] : [],
        ),
      },
      inboxMessage: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const spotlight: any = {
      forDm: jest.fn().mockResolvedValue([
        { post_id: 'p1', label: 'Diwali sale', caption: null, permalink: 'https://instagram.com/p/1', offering_ids: ['o1'] },
      ]),
    };
    const gate: any = { isPostAiOn: jest.fn().mockResolvedValue(true) };
    const svc = new ReplyContextService(prisma, { availability: jest.fn() } as any, gate, spotlight);

    const ctx = await svc.build({ orgId: 'o', text: 'hi', conversationId: 'c', channelId: 'ch1' });
    expect(ctx.spotlight.map((s) => s.label)).toEqual(['Diwali sale']);
    expect(ctx.allowed_links).toEqual(['https://instagram.com/p/1']);
    expect(ctx.offerings.map((o) => [o.id, o.match])).toEqual([['o1', 'spotlight']]);

    const onPost = await svc.build({ orgId: 'o', text: 'price?', postId: 'p9', channelId: 'ch1' });
    expect(onPost.spotlight).toEqual([]);
    expect(spotlight.forDm).toHaveBeenCalledTimes(1);
  });
});
