import { CommentPipelineService } from './comment-pipeline.service';
import { CommentQueueService } from './comment-queue.service';
import {
  isJunkComment,
  isRootComment,
  normalizeFacebook,
  normalizeInstagram,
  privateReplyAllowed,
  withTag,
  DM_CHECK_LINE,
} from './comments';

// ---------------------------------------------------------------- fake db

function matches(row: any, where: any, db: FakeDb): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    if (cond === undefined) return true;
    if (key === 'OR') return (cond as any[]).some((w) => matches(row, w, db));
    if (key === 'thread') {
      const thread = db.threads.find((t) => t.id === row.threadId);
      return Boolean(thread) && matches(thread, cond, db);
    }
    const v = row[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) return cond.in.includes(v);
      if ('not' in cond) return cond.not === null ? v != null : v !== cond.not;
      if ('lte' in cond) return v != null && v <= cond.lte;
      if ('lt' in cond) return v != null && v < cond.lt;
      if ('gt' in cond) return v != null && v > cond.gt;
      return false;
    }
    if (cond instanceof Date) return v?.getTime?.() === cond.getTime();
    return v === cond;
  });
}

function apply(row: any, data: any) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as any))
      row[k] = (row[k] || 0) + (v as any).increment;
    else row[k] = v;
  }
  row.updatedAt = new Date();
  return row;
}

class FakeDb {
  threads: any[] = [];
  jobs: any[] = [];
  seq = 0;
  id() {
    return `id${++this.seq}`;
  }
  prisma: any = {
    commentThread: {
      findUnique: async ({ where }: any) =>
        where.id
          ? this.threads.find((t) => t.id === where.id) || null
          : this.threads.find(
              (t) =>
                t.orgId === where.orgId_rootCommentId.orgId &&
                t.rootCommentId === where.orgId_rootCommentId.rootCommentId,
            ) || null,
      create: async ({ data }: any) => {
        if (
          this.threads.some(
            (t) =>
              t.orgId === data.orgId && t.rootCommentId === data.rootCommentId,
          )
        )
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        const row = {
          id: this.id(),
          dmSentAt: null,
          dmRecipientId: null,
          replyCount: 0,
          status: 'OPEN',
          createdAt: new Date(),
          ...data,
        };
        this.threads.push(row);
        return row;
      },
      update: async ({ where, data }: any) =>
        apply(
          this.threads.find((t) => t.id === where.id),
          data,
        ),
      count: async ({ where }: any) =>
        this.threads.filter((t) => matches(t, where, this)).length,
    },
    commentReplyJob: {
      create: async ({ data }: any) => {
        if (this.jobs.some((j) => j.commentId === data.commentId))
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        const now = new Date();
        const row = {
          id: this.id(),
          status: 'QUEUED',
          attempts: 0,
          dmSent: false,
          publicReply: null,
          privateDm: null,
          replyCommentId: null,
          sentAt: null,
          createdAt: now,
          updatedAt: now,
          runAfter: now,
          ...data,
        };
        this.jobs.push(row);
        return row;
      },
      findFirst: async ({ where, orderBy }: any) => {
        const rows = this.jobs.filter((j) => matches(j, where, this));
        if (orderBy?.runAfter === 'desc')
          rows.sort((a, b) => b.runAfter - a.runAfter);
        if (orderBy?.runAfter === 'asc')
          rows.sort((a, b) => a.runAfter - b.runAfter);
        return rows[0] || null;
      },
      findMany: async ({ where }: any) =>
        this.jobs.filter((j) => matches(j, where, this)),
      findUnique: async ({ where, include }: any) => {
        const j = this.jobs.find((x) => x.id === where.id);
        if (!j) return null;
        return include?.thread
          ? { ...j, thread: this.threads.find((t) => t.id === j.threadId) }
          : { ...j };
      },
      count: async ({ where }: any) =>
        this.jobs.filter((j) => matches(j, where, this)).length,
      update: async ({ where, data }: any) =>
        apply(
          this.jobs.find((j) => j.id === where.id),
          data,
        ),
      updateMany: async ({ where, data }: any) => {
        const rows = this.jobs.filter((j) => matches(j, where, this));
        rows.forEach((r) => apply(r, data));
        return { count: rows.length };
      },
    },
    channel: {
      findFirst: async () => ({
        id: 'ch1',
        orgId: 'org',
        name: 'Glam',
        isActive: true,
        status: 'ACTIVE',
        accessTokenEncrypted: 'enc',
        org: { name: 'Glam' },
      }),
    },
    interactionLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

// ---------------------------------------------------------------- harness

const CHANNEL = { id: 'ch1', orgId: 'org', channelIdentifier: 'ig-account' };

function harness(
  opts: {
    postOn?: boolean;
    dmOk?: boolean;
    publicStatus?: number;
    reply?: any;
  } = {},
) {
  const db = new FakeDb();
  const postOn = { value: opts.postOn ?? true };
  const gate: any = { isPostAiOn: jest.fn(async () => postOn.value) };
  const conversations: any = {
    attachComment: jest.fn(async (c: any) => ({ id: `conv-${c.authorId}` })),
    ingestOutbound: jest.fn().mockResolvedValue(undefined),
    linkPrivateReply: jest.fn(async (c: any) => ({
      id: `dm-${c.recipientId}`,
    })),
  };
  const meta: any = {
    sendPrivateReply: jest.fn(async () =>
      opts.dmOk === false
        ? { ok: false, status: 400, error: 'window closed' }
        : { ok: true, recipientId: 'igsid-1', messageId: 'm1' },
    ),
    replyToCommentWithId: jest.fn(async () =>
      opts.publicStatus && opts.publicStatus >= 400
        ? { ok: false, status: opts.publicStatus, error: 'meta error' }
        : { ok: true, id: `reply-${db.id()}`, status: 200 },
    ),
  };
  const engine: any = {
    reply: jest.fn(async (req: any) =>
      opts.reply !== undefined
        ? opts.reply
        : {
            public_reply: 'Haan, 100% cotton hai!',
            private_dm: 'Dress ₹1,499 hai. Aapka size?',
            intent: 'details',
            sentiment: 'neutral',
            requires_human_attention: false,
            action: 'ANSWER',
            offering_ids: [],
            guarded: false,
            _req: req,
          },
    ),
  };
  const queue = new CommentQueueService(
    db.prisma,
    { decrypt: () => 'tok' } as any,
    meta,
    conversations,
    engine,
    gate,
  );
  const pipeline = new CommentPipelineService(
    db.prisma,
    conversations,
    gate,
    queue,
  );
  const run = async () => {
    for (const j of db.jobs.filter((x) => x.status === 'QUEUED'))
      await queue.process(j.id);
  };
  return {
    db,
    gate,
    conversations,
    meta,
    engine,
    queue,
    pipeline,
    run,
    postOn,
  };
}

const ig = (over: any = {}) =>
  normalizeInstagram({
    id: over.id || 'c1',
    text: over.text ?? 'Is this pure cotton?',
    from: {
      id: over.from || 'u-priya',
      username: over.username || 'priya_sharma',
    },
    media: { id: 'post1' },
    ...(over.parent ? { parent_id: over.parent } : {}),
  })!;

// ---------------------------------------------------------------- pure rules

describe('comment rules', () => {
  it('finds root comments on both platforms', () => {
    expect(
      isRootComment({ platform: 'INSTAGRAM', parentId: null, postId: 'p' }),
    ).toBe(true);
    expect(
      isRootComment({ platform: 'INSTAGRAM', parentId: 'c1', postId: 'p' }),
    ).toBe(false);
    expect(
      isRootComment({ platform: 'FACEBOOK', parentId: 'p', postId: 'p' }),
    ).toBe(true);
    expect(
      isRootComment({ platform: 'FACEBOOK', parentId: 'c1', postId: 'p' }),
    ).toBe(false);
  });

  it.each([
    '😍😍',
    '@riya_k',
    '@a @b',
    'nice',
    'Nice!!',
    'wow wow',
    'ok',
    'Happy Diwali',
    'hi',
  ])('ignores "%s"', (text) => expect(isJunkComment(text)).toBe(true));

  it.each([
    'COD hai?',
    'price?',
    'XL milega',
    '@riya_k ye dekh, price kya hai?',
    'Is this pure cotton',
  ])('answers "%s"', (text) => expect(isJunkComment(text)).toBe(false));

  it('tags on Instagram, writes the first name on Facebook', () => {
    expect(withTag('INSTAGRAM', 'priya_sharma', '@someone Haan!')).toBe(
      '@priya_sharma Haan!',
    );
    expect(withTag('FACEBOOK', 'Priya Sharma', 'Haan!')).toBe('Priya, Haan!');
    expect(withTag('FACEBOOK', null, 'Haan!')).toBe('Haan!');
  });

  it('allows a Private Reply only to a fresh root comment, once per post', () => {
    const now = new Date('2026-10-10T10:00:00Z');
    const base = {
      isRoot: true,
      alreadySentOnPost: false,
      commentAt: now,
      queuedAt: now,
      now,
    };
    expect(privateReplyAllowed(base)).toBe(true);
    expect(privateReplyAllowed({ ...base, isRoot: false })).toBe(false);
    expect(privateReplyAllowed({ ...base, alreadySentOnPost: true })).toBe(
      false,
    );
    expect(
      privateReplyAllowed({
        ...base,
        commentAt: new Date('2026-10-02T09:00:00Z'),
      }),
    ).toBe(false);
    expect(
      privateReplyAllowed({
        ...base,
        queuedAt: new Date('2026-10-10T09:29:00Z'),
      }),
    ).toBe(false);
  });

  it('normalizes Facebook comments', () => {
    const c = normalizeFacebook({
      item: 'comment',
      verb: 'add',
      comment_id: 'fc1',
      post_id: 'page_post',
      parent_id: 'page_post',
      message: 'Price?',
      from: { id: 'fb-u', name: 'Rahul K' },
      created_time: 1790000000,
    })!;
    expect(c.platform).toBe('FACEBOOK');
    expect(isRootComment(c)).toBe(true);
    expect(c.createdAt?.getTime()).toBe(1790000000 * 1000);
  });
});

// ---------------------------------------------------------------- pipeline + queue

describe('comment pipeline and queue', () => {
  it('saves a comment on an AI-off post and sends nothing', async () => {
    const h = harness({ postOn: false });
    expect(await h.pipeline.handle(CHANNEL, ig())).toBe('post_ai_off');
    expect(h.conversations.attachComment).toHaveBeenCalled();
    expect(h.db.jobs).toHaveLength(0);
  });

  it('answers a crisis comment even on an AI-off post', async () => {
    const h = harness({
      postOn: false,
      reply: {
        public_reply: "We've sent you a message 🙏",
        private_dm: 'Tele-MANAS: 14416',
        intent: 'crisis',
        action: 'HANDOFF',
        offering_ids: [],
        guarded: false,
      },
    });
    expect(
      await h.pipeline.handle(CHANNEL, ig({ text: 'mujhe marna hai' })),
    ).toBe('crisis');
    await h.run();
    expect(h.meta.sendPrivateReply).toHaveBeenCalledWith(
      'c1',
      'Tele-MANAS: 14416',
      'tok',
    );
    expect(h.meta.replyToCommentWithId.mock.calls[0][2]).toBe(
      "@priya_sharma We've sent you a message 🙏",
    );
  });

  it('crisis comment whose DM fails gets the helpline publicly instead', async () => {
    const h = harness({
      dmOk: false,
      reply: {
        public_reply: "We've sent you a message 🙏",
        private_dm: 'help',
        offering_ids: [],
      },
    });
    await h.pipeline.handle(CHANNEL, ig({ text: 'I want to kill myself' }));
    await h.run();
    expect(h.meta.replyToCommentWithId.mock.calls[0][2]).toContain('14416');
    expect(h.meta.replyToCommentWithId.mock.calls[0][2]).not.toContain(
      'sent you a message',
    );
  });

  it('root comment: tagged public reply plus a Private Reply DM', async () => {
    const h = harness();
    expect(await h.pipeline.handle(CHANNEL, ig())).toBe('queued');
    await h.run();
    expect(h.meta.sendPrivateReply).toHaveBeenCalledWith(
      'c1',
      'Dress ₹1,499 hai. Aapka size?',
      'tok',
    );
    expect(h.meta.replyToCommentWithId.mock.calls[0][2]).toBe(
      `@priya_sharma Haan, 100% cotton hai! ${DM_CHECK_LINE}`,
    );
    const thread = h.db.threads[0];
    expect(thread.dmSentAt).toBeTruthy();
    expect(thread.dmRecipientId).toBe('igsid-1');
    expect(h.conversations.linkPrivateReply).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: 'igsid-1', postId: 'post1' }),
    );
    expect(h.db.jobs[0].status).toBe('SENT');
    expect(h.engine.reply.mock.calls[0][0].commentAuthor).toBe('priya_sharma');
  });

  it('nested replies (same or another user) join the root record: public only', async () => {
    const h = harness();
    await h.pipeline.handle(CHANNEL, ig());
    await h.run();
    await h.pipeline.handle(
      CHANNEL,
      ig({ id: 'c2', text: 'COD hai?', parent: 'c1' }),
    );
    await h.pipeline.handle(
      CHANNEL,
      ig({
        id: 'c3',
        text: 'XL milega?',
        parent: 'c1',
        from: 'u-rahul',
        username: 'rahul_k',
      }),
    );
    await h.run();
    expect(h.db.threads).toHaveLength(1);
    expect(h.db.threads[0].replyCount).toBe(2);
    expect(h.meta.sendPrivateReply).toHaveBeenCalledTimes(1);
    const texts = h.meta.replyToCommentWithId.mock.calls.map((c: any) => c[2]);
    expect(texts[1]).toBe('@priya_sharma Haan, 100% cotton hai!');
    expect(texts[2]).toBe('@rahul_k Haan, 100% cotton hai!');
  });

  it('a second root comment by the same person on the post gets no second DM', async () => {
    const h = harness();
    await h.pipeline.handle(CHANNEL, ig());
    await h.run();
    await h.pipeline.handle(CHANNEL, ig({ id: 'c9', text: 'Colours?' }));
    await h.run();
    expect(h.db.threads).toHaveLength(2);
    expect(h.meta.sendPrivateReply).toHaveBeenCalledTimes(1);
    expect(h.meta.replyToCommentWithId.mock.calls[1][2]).not.toContain(
      DM_CHECK_LINE,
    );
  });

  it('adopts a thread when the parent comment was never seen', async () => {
    const h = harness();
    await h.pipeline.handle(
      CHANNEL,
      ig({ id: 'c5', text: 'Price?', parent: 'old-root' }),
    );
    expect(h.db.threads[0]).toMatchObject({
      rootCommentId: 'old-root',
      status: 'ADOPTED',
    });
    await h.run();
    expect(h.meta.sendPrivateReply).not.toHaveBeenCalled();
    expect(h.meta.replyToCommentWithId).toHaveBeenCalled();
  });

  it('ignores junk, our own replies and the page itself', async () => {
    const h = harness();
    expect(await h.pipeline.handle(CHANNEL, ig({ text: '😍😍' }))).toBe('junk');
    expect(
      await h.pipeline.handle(CHANNEL, ig({ id: 'c7', from: 'ig-account' })),
    ).toBe('own');
    await h.pipeline.handle(CHANNEL, ig({ id: 'c8' }));
    await h.run();
    const ourId = h.db.jobs.find((j) => j.commentId === 'c8').replyCommentId;
    expect(
      await h.pipeline.handle(
        CHANNEL,
        ig({ id: ourId, from: 'someone-else', parent: 'c8' }),
      ),
    ).toBe('own');
    // Same text as our sent reply, on the same post.
    const sent = h.db.jobs.find((j) => j.commentId === 'c8').publicReply;
    expect(
      await h.pipeline.handle(
        CHANNEL,
        ig({ id: 'c-echo', text: sent, parent: 'c8', from: 'x' }),
      ),
    ).toBe('own');
  });

  it('old comment or long queue wait: public reply only', async () => {
    const h = harness();
    await h.pipeline.handle(CHANNEL, ig());
    h.db.jobs[0].createdAt = new Date(Date.now() - 31 * 60 * 1000);
    await h.run();
    expect(h.meta.sendPrivateReply).not.toHaveBeenCalled();
    expect(h.meta.replyToCommentWithId.mock.calls[0][2]).toBe(
      '@priya_sharma Haan, 100% cotton hai!',
    );
  });

  it('a failed Private Reply never says "DM check karein"', async () => {
    const h = harness({
      dmOk: false,
      reply: {
        public_reply: 'Haan! Details DM me bhej di hain.',
        private_dm: 'details',
        offering_ids: [],
      },
    });
    await h.pipeline.handle(CHANNEL, ig());
    await h.run();
    const text = h.meta.replyToCommentWithId.mock.calls[0][2];
    expect(text).toBe('@priya_sharma Haan!');
    expect(h.db.jobs[0].status).toBe('SENT');
    expect(h.db.jobs[0].dmSent).toBe(false);
  });

  it('never answers the same comment twice (webhook retries)', async () => {
    const h = harness();
    expect(await h.pipeline.handle(CHANNEL, ig())).toBe('queued');
    expect(await h.pipeline.handle(CHANNEL, ig())).toBe('duplicate');
    await h.run();
    await h.queue.process(h.db.jobs[0].id);
    expect(h.meta.replyToCommentWithId).toHaveBeenCalledTimes(1);
  });

  it('spaces answers 2–4 s apart on a channel', async () => {
    const h = harness();
    for (let i = 0; i < 5; i++)
      await h.pipeline.handle(CHANNEL, ig({ id: `b${i}`, from: `u${i}` }));
    const times = h.db.jobs.map((j) => j.runAfter.getTime());
    for (let i = 1; i < times.length; i++) {
      const d = times[i] - times[i - 1];
      expect(d).toBeGreaterThanOrEqual(2000);
      expect(d).toBeLessThanOrEqual(4000);
    }
  });

  it('holds a channel at 20 answers a minute', async () => {
    const h = harness();
    for (let i = 0; i < 20; i++)
      h.db.jobs.push({
        id: `s${i}`,
        channelId: 'ch1',
        status: 'SENT',
        sentAt: new Date(),
        runAfter: new Date(),
      });
    await h.pipeline.handle(CHANNEL, ig({ id: 'late' }));
    h.db.jobs.find((j) => j.commentId === 'late').runAfter = new Date(
      Date.now() - 1,
    );
    const process = jest.spyOn(h.queue, 'process');
    await h.queue.tick();
    expect(process).not.toHaveBeenCalled();
  });

  it('a deleted comment cancels its pending answers; edits are ignored', async () => {
    const h = harness();
    await h.pipeline.handle(CHANNEL, ig());
    await h.pipeline.handle(
      CHANNEL,
      ig({ id: 'c2', text: 'COD?', parent: 'c1' }),
    );
    expect(await h.pipeline.handle(CHANNEL, { ...ig(), verb: 'edited' })).toBe(
      'ignored',
    );
    expect(await h.pipeline.handle(CHANNEL, { ...ig(), verb: 'remove' })).toBe(
      'deleted',
    );
    expect(h.db.threads[0].status).toBe('DELETED');
    expect(h.db.jobs.every((j) => j.status === 'SKIPPED')).toBe(true);
    await h.run();
    expect(h.meta.replyToCommentWithId).not.toHaveBeenCalled();
  });

  it('skips a queued answer when the post is switched off meanwhile', async () => {
    const h = harness();
    await h.pipeline.handle(CHANNEL, ig());
    h.postOn.value = false;
    await h.run();
    expect(h.db.jobs[0]).toMatchObject({
      status: 'SKIPPED',
      error: 'post_ai_off',
    });
    expect(h.engine.reply).not.toHaveBeenCalled();
  });

  it('retries Meta 5xx twice, never 4xx', async () => {
    const five = harness({ publicStatus: 500 });
    await five.pipeline.handle(CHANNEL, ig());
    await five.run();
    expect(five.db.jobs[0].status).toBe('QUEUED');
    // The DM already went: the retry must not send it again.
    await five.queue.process(five.db.jobs[0].id);
    await five.queue.process(five.db.jobs[0].id);
    expect(five.db.jobs[0].status).toBe('FAILED');
    expect(five.meta.sendPrivateReply).toHaveBeenCalledTimes(1);
    expect(five.engine.reply).toHaveBeenCalledTimes(1);

    const four = harness({ publicStatus: 400 });
    await four.pipeline.handle(CHANNEL, ig());
    await four.run();
    expect(four.db.jobs[0].status).toBe('FAILED');
  });

  it('jobs survive a restart: stuck SENDING jobs go back in line', async () => {
    const h = harness();
    await h.pipeline.handle(CHANNEL, ig());
    Object.assign(h.db.jobs[0], {
      status: 'SENDING',
      updatedAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await h.queue.onModuleInit();
    } finally {
      h.queue.onModuleDestroy();
      process.env.NODE_ENV = env;
    }
    expect(h.db.jobs[0].status).toBe('QUEUED');
  });

  it('many items on one post: the public reply stays general, the DM lists them', async () => {
    const h = harness({
      reply: {
        public_reply: 'Is post me 3 designs hain!',
        private_dm: 'Red ₹1,499, Blue ₹1,599, Green ₹1,699. Kaunsa pasand hai?',
        offering_ids: ['a', 'b', 'c'],
      },
    });
    await h.pipeline.handle(CHANNEL, ig({ text: 'price?' }));
    await h.run();
    expect(h.meta.replyToCommentWithId.mock.calls[0][2]).not.toContain('₹');
    expect(h.meta.sendPrivateReply.mock.calls[0][1]).toContain(
      'Kaunsa pasand hai?',
    );
  });
});
