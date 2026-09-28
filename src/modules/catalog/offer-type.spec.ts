import { BadRequestException } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { ReplyContextService } from './reply-context.service';
import { nextStage } from './reply-engine.service';
import { defaultOfferType, offeringKind } from './industries';

describe('offer type', () => {
  it('defaults from the industry like the backfill', () => {
    expect(defaultOfferType('FOOTWEAR')).toBe('PRODUCTS');
    expect(defaultOfferType('BEAUTY_SERVICE')).toBe('SERVICES');
    expect(defaultOfferType('OTHER')).toBe('BOTH');
    expect(offeringKind('MENU_ITEM')).toBe('PRODUCTS');
    expect(offeringKind('PACKAGE')).toBe('SERVICES');
  });

  it('validates the page override and keeps categories tidy', async () => {
    const prisma: any = {
      channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch1' }) },
      pageProfile: {
        upsert: jest.fn(async ({ create }) => create),
        deleteMany: jest.fn(),
      },
      offering: { count: jest.fn() },
    };
    const svc = new CatalogService(prisma, {} as any);
    await expect(
      svc.savePageProfile('o', 'ch1', { offerType: 'NOPE' }),
    ).rejects.toThrow(BadRequestException);
    const saved: any = await svc.savePageProfile('o', 'ch1', {
      offerType: 'BOTH',
      categories: [' Bridal makeup ', 'Bridal makeup', '', 'Lehenga'],
    });
    expect(saved.offerType).toBe('BOTH');
    expect(saved.categories).toEqual(['Bridal makeup', 'Lehenga']);
  });

  it('fills the offer type from the industry when setup finishes without one', async () => {
    const prisma: any = {
      businessProfile: {
        findUnique: jest
          .fn()
          .mockResolvedValue({
            industry: 'HOTEL',
            description: 'Boutique hotel in Rishikesh by the Ganga',
            offerType: null,
          }),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    const svc = new CatalogService(prisma, {} as any);
    await svc.saveProfile('o', { completeOnboarding: true });
    expect(
      prisma.businessProfile.upsert.mock.calls[0][0].update.offerType,
    ).toBe('SERVICES');
  });
});

describe('discovery context', () => {
  function build(page: any, offerings: any[], goalState: any = {}) {
    const prisma: any = {
      businessProfile: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ industry: 'OTHER', offerType: null }),
      },
      conversation: { findUnique: jest.fn().mockResolvedValue({ goalState }) },
      pageProfile: { findFirst: jest.fn().mockResolvedValue(page) },
      socialPost: { findUnique: jest.fn() },
      postOfferingLink: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      offering: {
        findMany: jest.fn(async ({ where, select }: any) => {
          if (select?.type && !select?.title) return offerings; // overview query
          if (where?.id?.in)
            return offerings
              .filter((o) => where.id.in.includes(o.id))
              .map((o) => ({ ...o, variants: [], components: [] }));
          return []; // search finds nothing for "hi"
        }),
      },
      inboxMessage: { findMany: jest.fn().mockResolvedValue([]) },
    };
    return new ReplyContextService(prisma, { availability: jest.fn() } as any);
  }
  const items = [
    {
      id: 'p1',
      type: 'PRODUCT',
      title: 'Lehenga',
      priceMode: 'FIXED',
      priceMin: 9999,
      priceMax: null,
      currency: 'INR',
    },
    {
      id: 's1',
      type: 'SERVICE',
      title: 'Bridal makeup',
      priceMode: 'STARTING_FROM',
      priceMin: 18000,
      priceMax: null,
      currency: 'INR',
    },
  ];

  it('a plain "hi" gets overview items, the page offer type and categories', async () => {
    const ctx = await build(
      {
        offerType: 'BOTH',
        categories: ['Bridal makeup', 'Lehenga'],
        offeringIds: [],
      },
      items,
    ).build({
      orgId: 'o',
      text: 'hi',
      conversationId: 'c',
      channelId: 'ch1',
    });
    expect(ctx.business.offer_type).toBe('BOTH');
    expect(ctx.business.categories).toEqual(['Bridal makeup', 'Lehenga']);
    expect(ctx.offerings.map((o) => [o.id, o.match])).toEqual([
      ['p1', 'overview'],
      ['s1', 'overview'],
    ]);
  });

  it('a services page, or a customer who asked for services, sees services only', async () => {
    const svc = await build(
      { offerType: 'SERVICES', categories: [], offeringIds: [] },
      items,
    ).build({ orgId: 'o', text: 'hi', channelId: 'ch1' });
    expect(svc.offerings.map((o) => o.id)).toEqual(['s1']);
    const chose = await build(
      { offerType: 'BOTH', categories: [], offeringIds: [] },
      items,
      { offeringType: 'PRODUCTS' },
    ).build({
      orgId: 'o',
      text: 'hi',
      conversationId: 'c',
      channelId: 'ch1',
    });
    expect(chose.offerings.map((o) => o.id)).toEqual(['p1']);
  });
});

describe('conversation stage', () => {
  it('moves forward only', () => {
    expect(
      nextStage(undefined, { action: 'ANSWER', offering_ids: [] }, false),
    ).toBe('DISCOVER');
    expect(
      nextStage('DISCOVER', { action: 'ANSWER', offering_ids: ['o1'] }, false),
    ).toBe('QUOTE');
    expect(nextStage('QUOTE', { action: 'ASK_FIELD' }, false)).toBe('COLLECT');
    expect(nextStage('COLLECT', { action: 'HANDOFF' }, true)).toBe('COLLECT');
    expect(nextStage('COLLECT', { action: 'CREATE_LEAD' }, true)).toBe('DONE');
  });
});
