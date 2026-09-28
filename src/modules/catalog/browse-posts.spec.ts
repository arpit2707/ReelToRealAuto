import { PostTaggingService } from './post-tagging.service';
import { PostsService } from '../posts/posts.service';

describe('PostTaggingService.browsePosts', () => {
  const post = (id: string, text = '') => ({
    id,
    text,
    mediaUrl: `https://cdn/${id}.jpg`,
    mediaType: 'IMAGE',
    permalink: `https://instagram.com/p/${id}`,
    createdAt: '2026-09-28T10:00:00+0000',
    likes: 3,
    commentsCount: 1,
    comments: null,
  });

  function make() {
    const prisma: any = {
      channel: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'fb', platform: 'FACEBOOK', name: 'Page' },
          { id: 'ig', platform: 'INSTAGRAM', name: 'insta' },
        ]),
      },
      socialPost: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
        findMany: jest
          .fn()
          .mockResolvedValue([
            {
              postId: 'p1',
              note: 'Offer valid till Sunday, sizes M and L',
              source: 'META',
              aiEnabled: true,
            },
          ]),
      },
      postOfferingLink: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'l2',
            postId: 'p2',
            offering: {
              id: 'o1',
              title: 'Meme Tshirt',
              type: 'PRODUCT',
              isActive: true,
            },
            status: 'SELLER_CONFIRMED',
            confidence: 1,
            reason: 'Added by seller',
          },
        ]),
      },
    };
    const posts = {
      pagePosts: jest.fn().mockResolvedValue({
        channelId: 'ig',
        platform: 'INSTAGRAM',
        posts: [post('p1', 'quote'), post('p2', 'tshirt'), post('p3')],
        paging: { after: 'CUR', before: null },
      }),
    };
    const gate = { onPosts: jest.fn().mockResolvedValue(new Set(['p1'])) };
    const svc = new PostTaggingService(
      prisma,
      posts as any,
      {} as any,
      {} as any,
      {} as any,
      gate as any,
    );
    return { svc, prisma, posts };
  }

  it("lists the Instagram page by default, with each post's note, items and switch", async () => {
    const { svc, prisma, posts } = make();
    const r = await svc.browsePosts('org', {});
    expect(posts.pagePosts).toHaveBeenCalledWith('org', 'ig', {
      after: undefined,
      before: undefined,
    });
    expect(r.channelId).toBe('ig');
    expect(r.paging).toEqual({ after: 'CUR', before: null });
    const [p1, p2, p3] = r.posts;
    expect(p1).toMatchObject({
      note: 'Offer valid till Sunday, sizes M and L',
      aiEnabled: true,
      aiOn: true,
      hasContext: true,
    });
    expect(p2).toMatchObject({
      aiOn: false,
      hasContext: true,
      tags: [expect.objectContaining({ id: 'l2' })],
    });
    expect(p3).toMatchObject({
      note: null,
      hasContext: false,
      needsContext: true,
      tags: [],
    });
    // Stored without marking them matched, and without touching existing rows.
    const stored = prisma.socialPost.createMany.mock.calls[0][0];
    expect(stored.skipDuplicates).toBe(true);
    expect(stored.data[0]).not.toHaveProperty('taggedAt');
    expect(stored.data[0]).toMatchObject({
      orgId: 'org',
      postId: 'p1',
      channelId: 'ig',
    });
  });

  it('uses the chosen page and cursor', async () => {
    const { svc, posts } = make();
    await svc.browsePosts('org', { channelId: 'fb', after: 'X' });
    expect(posts.pagePosts).toHaveBeenCalledWith('org', 'fb', {
      after: 'X',
      before: undefined,
    });
  });

  it('asks to connect a page when there is none', async () => {
    const { svc, prisma } = make();
    prisma.channel.findMany.mockResolvedValue([]);
    await expect(svc.browsePosts('org', {})).rejects.toThrow(
      'Connect an Instagram',
    );
  });
});

describe('PostsService.pagePosts', () => {
  function make(json: any) {
    const prisma: any = {
      channel: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'ig',
          orgId: 'org',
          platform: 'INSTAGRAM',
          channelIdentifier: '178',
          isActive: true,
          status: 'ACTIVE',
          accessTokenEncrypted: 'enc',
          name: 'insta',
        }),
      },
    };
    const svc = new PostsService(
      prisma,
      { decrypt: () => 'tok' } as any,
      {} as any,
    );
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => json });
    (global as any).fetch = fetchMock;
    return { svc, fetchMock };
  }

  it('asks Meta for 10 posts and passes the cursor on', async () => {
    const { svc, fetchMock } = make({
      data: [
        {
          id: '1',
          caption: 'hi',
          media_type: 'VIDEO',
          thumbnail_url: 't',
          media_url: 'v',
        },
      ],
      paging: {
        cursors: { after: 'A', before: 'B' },
        next: 'n',
        previous: 'p',
      },
    });
    const r = await svc.pagePosts('org', 'ig', { after: 'PREV' });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toMatch(/\/178\/media$/);
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.get('after')).toBe('PREV');
    expect(r.posts[0]).toMatchObject({ id: '1', text: 'hi', mediaUrl: 't' });
    expect(r.paging).toEqual({ after: 'A', before: 'B' });
  });

  it('has no previous page on the first page and no next page at the end', async () => {
    const { svc } = make({
      data: [],
      paging: { cursors: { after: 'A', before: 'B' } },
    });
    const r = await svc.pagePosts('org', 'ig');
    expect(r.paging).toEqual({ after: null, before: null });
  });
});
