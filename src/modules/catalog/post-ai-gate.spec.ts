import { BadRequestException } from '@nestjs/common';
import { PostAiGateService, postHasContext } from './post-ai-gate.service';

function prismaWith(social: any, confirmed = 0) {
  const store = { social: social ? { ...social } : null };
  return {
    store,
    prisma: {
      socialPost: {
        findUnique: jest.fn(async () => store.social),
        findMany: jest.fn(async () => (store.social ? [store.social] : [])),
        update: jest.fn(async ({ data }) => (store.social = { ...store.social, ...data })),
        create: jest.fn(async ({ data }) => (store.social = { aiEnabled: false, aiEnabledAt: null, note: null, source: 'META', ...data })),
      },
      postOfferingLink: {
        count: jest.fn(async () => confirmed),
        findMany: jest.fn(async () => Array.from({ length: confirmed }, () => ({ postId: 'p1' }))),
        findFirst: jest.fn(async () => ({ platform: 'INSTAGRAM', caption: 'c', mediaUrl: null, permalink: null })),
      },
    } as any,
  };
}

const META = { postId: 'p1', aiEnabled: false, aiEnabledAt: null, note: null, source: 'META' };
const DAILY = { ...META, source: 'DAILY_POST' };

describe('post AI gate', () => {
  it('needs a confirmed item or a 20+ character note; daily posts need the note', () => {
    expect(postHasContext(META, 0)).toBe(false);
    expect(postHasContext(META, 1)).toBe(true);
    expect(postHasContext({ ...META, note: 'Diwali offer till Sunday only!' }, 0)).toBe(true);
    expect(postHasContext({ ...META, note: 'offer' }, 0)).toBe(false);
    expect(postHasContext(DAILY, 2)).toBe(false);
    expect(postHasContext({ ...DAILY, note: 'Bridal look, Patna, home visit' }, 0)).toBe(true);
  });

  it('is off for untagged posts and for a switched-on post without context', async () => {
    const gate = new PostAiGateService(prismaWith(META).prisma);
    expect(await gate.isPostAiOn('o', 'p1')).toBe(false);
    const noContext = new PostAiGateService(prismaWith({ ...META, aiEnabled: true }).prisma);
    expect(await noContext.isPostAiOn('o', 'p1')).toBe(false);
    const on = new PostAiGateService(prismaWith({ ...META, aiEnabled: true }, 1).prisma);
    expect(await on.isPostAiOn('o', 'p1')).toBe(true);
    expect(await on.isPostAiOn('o', null)).toBe(false);
  });

  it('refuses to switch on without context', async () => {
    const gate = new PostAiGateService(prismaWith(META).prisma);
    await expect(gate.setPostAi('o', 'p1', true, 'u1')).rejects.toThrow(BadRequestException);
    const daily = new PostAiGateService(prismaWith(DAILY, 3).prisma);
    await expect(daily.setPostAi('o', 'p1', true, 'u1')).rejects.toThrow(/context/);
  });

  it('switches on with context and off any time', async () => {
    const { prisma, store } = prismaWith(META, 1);
    const gate = new PostAiGateService(prisma);
    expect((await gate.setPostAi('o', 'p1', true, 'u1')).on).toBe(true);
    expect(store.social.aiEnabledBy).toBe('u1');
    expect((await gate.setPostAi('o', 'p1', false, 'u1')).on).toBe(false);
  });

  it('turns a daily post on when its context arrives', async () => {
    const { prisma, store } = prismaWith({ ...DAILY, note: 'Party makeup offer, Patna only' });
    const status = await new PostAiGateService(prisma).onContextChanged('o', 'p1');
    expect(status.on).toBe(true);
    expect(store.social.aiEnabled).toBe(true);
  });

  it('does not override a seller who switched the post off', async () => {
    const { prisma, store } = prismaWith({ ...META, aiEnabledAt: new Date() }, 1);
    await new PostAiGateService(prisma).onContextChanged('o', 'p1');
    expect(store.social.aiEnabled).toBe(false);
  });

  it('turns the post off when every item is rejected and there is no note', async () => {
    const { prisma, store } = prismaWith({ ...META, aiEnabled: true, aiEnabledAt: new Date() }, 0);
    const status = await new PostAiGateService(prisma).onContextChanged('o', 'p1');
    expect(status.on).toBe(false);
    expect(store.social.aiEnabled).toBe(false);
    // Losing context is not the seller's choice, so it can come back on.
    expect(store.social.aiEnabledAt).toBeNull();
  });
});
