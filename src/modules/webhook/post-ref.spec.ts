import { describeAttachments, extractPostRef } from './post-ref';
import { WebhookService } from './webhook.service';
import { ReplyContextService } from '../catalog/reply-context.service';

describe('extractPostRef', () => {
  it('reads story replies, ads, links, postbacks and shares', () => {
    expect(
      extractPostRef({ message: { reply_to: { story: { id: 's1' } } } }),
    ).toEqual({ postId: 's1', kind: 'story' });
    expect(
      extractPostRef({
        message: { referral: { ads_context_data: { post_id: 'ad1' } } },
      }),
    ).toEqual({ postId: 'ad1', kind: 'ad' });
    expect(extractPostRef({ referral: { ref: 'post_123' } })).toEqual({
      postId: '123',
      kind: 'link',
    });
    expect(
      extractPostRef({
        postback: { referral: { ads_context_data: { post_id: 'p9' } } },
      }),
    ).toEqual({ postId: 'p9', kind: 'ad' });
    expect(
      extractPostRef({
        message: {
          attachments: [{ type: 'ig_reel', payload: { reel_video_id: 'r1' } }],
        },
      }),
    ).toEqual({
      postId: 'r1',
      kind: 'share',
    });
    expect(
      extractPostRef({
        message: {
          attachments: [
            {
              type: 'share',
              payload: { url: 'https://instagram.com/p/x/?a=1' },
            },
          ],
        },
      }),
    ).toEqual({
      permalink: 'https://instagram.com/p/x/?a=1',
      kind: 'share',
    });
    expect(extractPostRef({ message: { text: 'hi' } })).toBeNull();
  });

  it('describes messages without text', () => {
    expect(
      describeAttachments({ message: { attachments: [{ type: 'ig_reel' }] } }),
    ).toBe('[Shared a reel]');
    expect(
      describeAttachments({ message: { attachments: [{ type: 'image' }] } }),
    ).toBe('[Photo]');
    expect(describeAttachments({ message: { text: 'hi' } })).toBeNull();
  });
});

describe('Instagram DMs about a post', () => {
  function make(postOn: boolean) {
    const prisma: any = {
      webhookEvent: { create: jest.fn().mockResolvedValue({}) },
      processedWebhookEvent: { create: jest.fn().mockResolvedValue({}) },
      channel: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'ch1',
          orgId: 'org',
          accessTokenEncrypted: 'enc',
          org: { name: 'Glam' },
        }),
      },
      socialPost: {
        findFirst: jest.fn().mockResolvedValue({ postId: 'from-link' }),
      },
      interactionLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const conversations: any = {
      ingestInbound: jest.fn().mockResolvedValue({ id: 'conv1' }),
      ingestOutbound: jest.fn().mockResolvedValue(undefined),
      markSource: jest.fn().mockResolvedValue(undefined),
    };
    const replies: any = {
      reply: jest
        .fn()
        .mockResolvedValue({
          private_dm: 'Haan',
          offering_ids: [],
          action: 'ANSWER',
        }),
    };
    const meta: any = { sendPrivateDm: jest.fn().mockResolvedValue(true) };
    const gate: any = { isPostAiOn: jest.fn().mockResolvedValue(postOn) };
    const service = new WebhookService(
      prisma,
      { decrypt: () => 'tok' } as any,
      {} as any,
      meta,
      {} as any,
      conversations,
      {} as any,
      replies,
      {} as any,
      undefined,
      gate,
    );
    const send = (messaging: any) =>
      service.processWebhookEvent({
        object: 'instagram',
        entry: [{ id: 'ig-account', messaging: [messaging] }],
      });
    return { service, conversations, replies, send, prisma };
  }

  it('a reel share without text is answered in the post context when its AI is on', async () => {
    const { send, replies, conversations } = make(true);
    await send({
      sender: { id: 'u1' },
      message: {
        mid: 'm1',
        attachments: [{ type: 'ig_reel', payload: { reel_video_id: 'r1' } }],
      },
    });
    expect(conversations.ingestInbound.mock.calls[0][0]).toMatchObject({
      text: '[Shared a reel]',
      type: 'SHARE',
    });
    expect(conversations.markSource).toHaveBeenCalledWith(
      'conv1',
      'r1',
      'INSTAGRAM',
      'share',
    );
    expect(replies.reply.mock.calls[0][0]).toMatchObject({
      postId: 'r1',
      eventType: 'dm',
    });
  });

  it('a reel share without text on an AI-off post is only saved', async () => {
    const { send, replies, conversations } = make(false);
    await send({
      sender: { id: 'u1' },
      message: {
        mid: 'm2',
        attachments: [{ type: 'ig_reel', payload: { reel_video_id: 'r1' } }],
      },
    });
    expect(conversations.ingestInbound).toHaveBeenCalled();
    expect(replies.reply).not.toHaveBeenCalled();
  });

  it('a story reply with text passes the story to the reply engine', async () => {
    const { send, replies } = make(false);
    await send({
      sender: { id: 'u1' },
      message: {
        mid: 'm3',
        text: 'price?',
        reply_to: { story: { id: 'st1' } },
      },
    });
    // The engine (via the context) decides whether the post may be used.
    expect(replies.reply.mock.calls[0][0]).toMatchObject({
      postId: 'st1',
      text: 'price?',
    });
  });

  it('a shared link is matched to a known post by permalink', async () => {
    const { send, replies, prisma } = make(true);
    await send({
      sender: { id: 'u1' },
      message: {
        mid: 'm4',
        text: 'ye wala?',
        attachments: [
          {
            type: 'share',
            payload: { url: 'https://instagram.com/p/abc/?igsh=x' },
          },
        ],
      },
    });
    expect(
      prisma.socialPost.findFirst.mock.calls[0][0].where.permalink,
    ).toEqual({ startsWith: 'https://instagram.com/p/abc' });
    expect(replies.reply.mock.calls[0][0].postId).toBe('from-link');
  });
});

describe('ReplyContextService post memory', () => {
  function build(convo: any, on: Record<string, boolean>) {
    const prisma: any = {
      businessProfile: {
        findUnique: jest.fn().mockResolvedValue({ industry: 'APPAREL' }),
      },
      conversation: { findUnique: jest.fn().mockResolvedValue(convo) },
      pageProfile: { findFirst: jest.fn().mockResolvedValue(null) },
      socialPost: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ caption: 'Summer dress', note: null }),
      },
      postOfferingLink: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      offering: { findMany: jest.fn().mockResolvedValue([]) },
      inboxMessage: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const gate: any = {
      isPostAiOn: jest.fn(async (_o: string, p: string) => Boolean(on[p])),
    };
    return new ReplyContextService(
      prisma,
      { availability: jest.fn() } as any,
      gate,
    );
  }
  const recent = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();

  it('remembers the chat post for 7 days', async () => {
    const svc = build(
      { goalState: { postId: 'p1', postAt: recent } },
      { p1: true },
    );
    expect(
      (
        await svc.build({
          orgId: 'o',
          text: 'isme bridal entry hai?',
          conversationId: 'c',
        })
      ).post_id,
    ).toBe('p1');
    const stale = build(
      { goalState: { postId: 'p1', postAt: old } },
      { p1: true },
    );
    expect(
      (await stale.build({ orgId: 'o', text: 'hi', conversationId: 'c' }))
        .post_id,
    ).toBeNull();
  });

  it('never uses a post whose AI is off; falls back to the remembered one', async () => {
    const svc = build(
      { goalState: { postId: 'p1', postAt: recent } },
      { p1: true, p2: false },
    );
    const ctx = await svc.build({
      orgId: 'o',
      text: 'price?',
      postId: 'p2',
      conversationId: 'c',
    });
    expect(ctx.post_id).toBe('p1');
    const none = build(null, { p2: false });
    const plain = await none.build({
      orgId: 'o',
      text: 'price?',
      postId: 'p2',
    });
    expect(plain.post_id).toBeNull();
    expect(plain.post).toBeNull();
  });
});
