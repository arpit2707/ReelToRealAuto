import { InboxService, pauseReason } from './inbox.service';

const now = new Date('2026-10-01T10:00:00Z');
const hours = (h: number) =>
  new Date(now.getTime() + h * 60 * 60 * 1000).toISOString();

describe('inbox pause reason', () => {
  it('says why the AI is quiet', () => {
    expect(pauseReason({ aiEnabled: true, goalState: {} }, now)).toBeNull();
    expect(
      pauseReason(
        {
          aiEnabled: false,
          goalState: { crisisAt: hours(-1), handoffReason: 'crisis' },
        },
        now,
      ),
    ).toBe('crisis');
    expect(
      pauseReason(
        { aiEnabled: true, goalState: { handedOffUntil: hours(5) } },
        now,
      ),
    ).toBe('handoff');
    expect(
      pauseReason(
        { aiEnabled: true, goalState: { sellerPausedUntil: hours(3) } },
        now,
      ),
    ).toBe('seller_replied');
    expect(
      pauseReason(
        { aiEnabled: true, goalState: { sellerPausedUntil: hours(-1) } },
        now,
      ),
    ).toBeNull();
    expect(pauseReason({ aiEnabled: false, goalState: {} }, now)).toBe('off');
  });
});

describe('InboxService threads and messages', () => {
  function build(conversations: any[], messages: any[] = []) {
    const prisma: any = {
      conversation: {
        findMany: jest.fn().mockResolvedValue(conversations),
        findFirst: jest.fn().mockResolvedValue(conversations[0]),
      },
      socialPost: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            {
              postId: 'p1',
              caption: 'Diwali silk sarees',
              mediaUrl: 'https://cdn/p1.jpg',
              permalink: 'https://ig/p1',
              platform: 'INSTAGRAM',
            },
          ]),
      },
      postOfferingLink: {
        findMany: jest.fn().mockResolvedValue([
          {
            postId: 'p1',
            mediaUrl: null,
            permalink: null,
            caption: null,
            offering: {
              id: 'o1',
              title: 'Silk saree',
              priceMode: 'FIXED',
              priceMin: 2499,
              priceMax: null,
              currency: 'INR',
              isActive: true,
            },
          },
        ]),
      },
      inboxMessage: { findMany: jest.fn().mockResolvedValue(messages) },
    };
    const service = new InboxService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      { inboxChanged: jest.fn() } as any,
    );
    return { service, prisma };
  }
  const base = {
    contact: { platformUserId: 'u1', name: 'Asha' },
    channel: { platform: 'INSTAGRAM' },
    messages: [{ body: 'price?' }],
    status: 'OPEN',
    lastInboundAt: now,
    updatedAt: now,
    windowExpiresAt: null,
    aiEnabled: true,
  };

  it('shows the source post with its items, needs-you and the pause reason', async () => {
    const { service } = build([
      {
        ...base,
        id: 'c1',
        sourcePostId: 'p1',
        sourceKind: 'comment',
        sourcePlatform: 'INSTAGRAM',
        goalState: {
          handoffReason: 'complaint',
          handedOffUntil: new Date(Date.now() + 3600e3).toISOString(),
        },
      },
      {
        ...base,
        id: 'c2',
        sourcePostId: null,
        goalState: {
          sellerPausedUntil: new Date(Date.now() + 3600e3).toISOString(),
        },
      },
    ]);
    const [c1, c2] = await service.listThreads('org1', 'instagram');
    expect(c1).toMatchObject({
      needsYou: true,
      handoffReason: 'complaint',
      pauseReason: 'handoff',
      aiPaused: true,
    });
    expect(c1.source).toEqual({
      postId: 'p1',
      kind: 'comment',
      platform: 'INSTAGRAM',
      caption: 'Diwali silk sarees',
      thumbnail: 'https://cdn/p1.jpg',
      permalink: 'https://ig/p1',
      items: [
        {
          id: 'o1',
          title: 'Silk saree',
          price: expect.stringContaining('2,499'),
        },
      ],
    });
    expect(c2).toMatchObject({
      needsYou: false,
      pauseReason: 'seller_replied',
      source: null,
    });
  });

  it('a soft reason is not "needs you"; an old post memory is not the source', async () => {
    const { service, prisma } = build([
      {
        ...base,
        id: 'c3',
        sourcePostId: null,
        goalState: {
          handoffReason: 'missing_information',
          postId: 'p1',
          postAt: '2026-01-01T00:00:00Z',
        },
      },
    ]);
    const [c3] = await service.listThreads('org1', 'instagram');
    expect(c3.needsYou).toBe(false);
    expect(c3.source).toBeNull();
    expect(prisma.socialPost.findMany).not.toHaveBeenCalled();
  });

  it('marks comments apart from DMs in the chat', async () => {
    const { service } = build(
      [{ ...base, id: 'c1', goalState: {} }],
      [
        {
          direction: 'INBOUND',
          type: 'COMMENT',
          body: 'price?',
          payload: { kind: 'comment', postId: 'p1' },
          createdAt: now,
        },
        {
          direction: 'OUTBOUND',
          sentBy: 'AI',
          type: 'TEXT',
          body: 'DM',
          payload: null,
          createdAt: now,
        },
      ],
    );
    const msgs = await service.listMessages('org1', 'instagram', 'c1');
    expect(msgs.map((m) => [m.kind, m.postId, m.from])).toEqual([
      ['comment', 'p1', 'customer'],
      ['dm', null, 'ai'],
    ]);
  });
});
