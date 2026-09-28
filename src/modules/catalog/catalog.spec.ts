import { extractAmounts, unknownPrices, allowedAmounts } from './price-guard';
import { parseCsv } from './csv';
import { priceLabel, industryOf } from './industries';
import { tokens } from './reply-context.service';
import { ReplyEngineService } from './reply-engine.service';
import { missingForActivation, serviceFor } from './onboarding';

describe('price guard', () => {
  it('reads rupee amounts in the ways Indian sellers write them', () => {
    expect(extractAmounts('Price ₹1,899 hai')).toEqual([1899]);
    expect(extractAmounts('sirf Rs. 499 me')).toEqual([499]);
    expect(extractAmounts('1499/- only')).toEqual([1499]);
    expect(extractAmounts('₹18k se start')).toEqual([18000]);
    expect(extractAmounts('budget 45 lakh tak')).toEqual([4500000]);
    expect(extractAmounts('size 8 available hai')).toEqual([]);
  });

  it('allows catalog prices, variant prices and what the customer said', () => {
    const allowed = allowedAmounts([
      { priceMin: 18000, priceMax: null, variants: [{ price: 2500 }] },
    ]);
    expect(
      unknownPrices('Bridal look ₹18,000 se start, hair ₹2,500', allowed),
    ).toEqual([]);
    expect(
      unknownPrices(
        'Aapke 50 lakh budget me options hain',
        allowed,
        'budget 50 lakh hai',
      ),
    ).toEqual([]);
  });

  it('flags a price the AI made up', () => {
    const allowed = allowedAmounts([{ priceMin: 1899 }]);
    expect(unknownPrices('Ye ₹1,499 ka hai', allowed)).toEqual([1499]);
  });
});

describe('csv', () => {
  it('handles quotes, commas inside quotes and CRLF', () => {
    const rows = parseCsv(
      'title,price,description\r\n"Loafer, Tan",1899,"Say ""hi"""\r\nSneaker,999,\r\n',
    );
    expect(rows).toEqual([
      ['title', 'price', 'description'],
      ['Loafer, Tan', '1899', 'Say "hi"'],
      ['Sneaker', '999', ''],
    ]);
  });
});

describe('industries', () => {
  it('words prices by mode', () => {
    const base = { priceMin: 18000, priceMax: null, currency: 'INR' };
    expect(priceLabel({ ...base, priceMode: 'STARTING_FROM' })).toBe(
      '₹18,000 se start',
    );
    expect(priceLabel({ ...base, priceMode: 'PER_NIGHT' })).toBe(
      '₹18,000 per night',
    );
    expect(
      priceLabel({
        priceMode: 'RANGE',
        priceMin: 4500000,
        priceMax: 6000000,
        currency: 'INR',
      }),
    ).toBe('₹45,00,000 – ₹60,00,000');
    expect(
      priceLabel({
        priceMode: 'ON_REQUEST',
        priceMin: null,
        priceMax: null,
        currency: 'INR',
      }),
    ).toBe('price on request');
  });

  it('falls back to apparel for an unknown industry', () => {
    expect(industryOf('NOPE').code).toBe('APPAREL');
    expect(industryOf('BEAUTY_SERVICE').goal).toBe('BOOKING');
  });

  it('drops Hinglish filler words from search tokens', () => {
    expect(tokens('Bhai ye loafer kitne ka hai? size 8')).toEqual([
      'loafer',
      'size',
    ]);
  });
});

describe('ReplyEngineService', () => {
  const offering = {
    id: 'o1',
    price_min: 18000,
    price_max: null,
    variants: [],
  };
  const baseCtx = {
    business: {},
    playbook: {
      goal: 'BOOKING',
      lead_fields: [
        { key: 'date', label: 'Date', ask: '' },
        { key: 'city', label: 'City', ask: '' },
      ],
      rules: [],
    },
    offerings: [offering],
    goal_state: {},
    recent_messages: [],
    allowed_prices: [18000],
  };

  const activeProfile = {
    industry: 'BEAUTY_SERVICE',
    onboardedAt: new Date('2026-09-01'),
    activatedAt: new Date('2026-09-01'),
    services: ['DM_REPLY', 'COMMENT_REPLY', 'WHATSAPP_REPLY'],
    businessName: 'Glam by Riya',
  };

  function make(
    ai: any,
    convo: any = { aiEnabled: true, goalState: null },
    profile: any = activeProfile,
  ) {
    const prisma: any = {
      businessProfile: { findUnique: jest.fn().mockResolvedValue(profile) },
      conversation: {
        findUnique: jest.fn().mockResolvedValue(convo),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const leads: any = {
      upsertFromConversation: jest.fn().mockResolvedValue({ id: 'lead1' }),
    };
    const engine = new ReplyEngineService(
      prisma,
      { generateReply: jest.fn().mockResolvedValue(ai) } as any,
      { build: jest.fn().mockResolvedValue(baseCtx) } as any,
      leads,
    );
    return { engine, prisma, leads };
  }

  const req = {
    orgId: 'org',
    brandName: 'B',
    platform: 'INSTAGRAM' as const,
    eventType: 'comment' as const,
    text: 'kitne ka?',
    senderId: 's',
    conversationId: 'c1',
  };

  it('replaces a reply that quotes a price not in the catalog', async () => {
    const { engine } = make({
      public_reply: 'Sirf ₹9,999!',
      private_dm: 'Ye look ₹9,999 ka hai',
      intent: 'price',
      sentiment: 'neutral',
      requires_human_attention: false,
    });
    const out = await engine.reply(req);
    expect(out?.guarded).toBe(true);
    expect(out?.private_dm).not.toContain('9,999');
    expect(out?.public_reply).not.toContain('9,999');
    expect(out?.requires_human_attention).toBe(true);
  });

  it('keeps a reply that uses the catalog price', async () => {
    const { engine } = make({
      public_reply: 'DM check karo',
      private_dm: 'Bridal look ₹18,000 se start. Date kya hai?',
      intent: 'price',
      sentiment: 'neutral',
      requires_human_attention: false,
      action: 'ASK_FIELD',
      offering_ids: ['o1', 'not-in-context'],
    });
    const out = await engine.reply(req);
    expect(out?.guarded).toBe(false);
    expect(out?.offering_ids).toEqual(['o1']);
  });

  it('pauses the chat for a day when the AI hands it to a person', async () => {
    const { engine, prisma } = make({
      private_dm: 'Team aapse baat karegi',
      requires_human_attention: true,
      action: 'HANDOFF',
      handoff_reason: 'complaint',
    });
    await engine.reply({ ...req, eventType: 'dm' });
    const saved = prisma.conversation.update.mock.calls[0][0].data.goalState;
    expect(saved.handedOffUntil).toBeTruthy();
  });

  it('does not pause the chat when the AI failed for a technical reason', async () => {
    for (const ai of [
      { private_dm: null, requires_human_attention: true, intent: 'ai_unavailable' },
      {
        private_dm: 'queued',
        requires_human_attention: true,
        action: 'HANDOFF',
        handoff_reason: 'generation_unavailable',
      },
    ]) {
      const { engine, prisma } = make(ai);
      await engine.reply({ ...req, eventType: 'dm' });
      const saved = prisma.conversation.update.mock.calls[0][0].data.goalState;
      expect(saved.handedOffUntil).toBeUndefined();
    }
  });

  it('says nothing when the seller has taken over the chat', async () => {
    const { engine } = make({}, { aiEnabled: false, goalState: null });
    expect(await engine.reply(req)).toBeNull();
  });

  it('stays silent until the seller finishes setup', async () => {
    const ai = { private_dm: 'hi', public_reply: 'hi' };
    const { engine } = make(ai, undefined, null);
    expect(await engine.reply(req)).toBeNull();
    const pending = make(ai, undefined, {
      ...activeProfile,
      onboardedAt: null,
      activatedAt: null,
      services: ['COMMENT_REPLY'],
    });
    expect(await pending.engine.reply(req)).toBeNull();
    // A preview still shows what the AI would say.
    expect(await engine.reply(req, { preview: true })).not.toBeNull();
  });

  it('answers only the automations the seller switched on', async () => {
    const ai = {
      private_dm: 'Details DM me',
      public_reply: 'DM check karo',
      intent: 'x',
      sentiment: 'neutral',
      requires_human_attention: false,
    };
    const { engine } = make(ai, undefined, {
      ...activeProfile,
      services: ['DM_REPLY'],
    });
    expect(await engine.reply(req)).toBeNull();
    expect(await engine.reply({ ...req, eventType: 'dm' })).not.toBeNull();
    expect(
      await engine.reply({ ...req, platform: 'WHATSAPP', eventType: 'dm' }),
    ).toBeNull();
  });

  it('lets the dashboard preview work before onboarding', async () => {
    const { engine } = make({ private_dm: 'hi' }, undefined, null);
    expect(
      await engine.reply({ ...req, conversationId: null, preview: true }),
    ).not.toBeNull();
  });

  it('sends the business name and tone to the AI', async () => {
    const { engine } = make({ private_dm: 'hi' }, undefined, {
      ...activeProfile,
      replyTone: 'formal',
      audience: 'Brides in Patna',
    });
    await engine.reply(req);
    const sent = (engine as any).aiClient.generateReply.mock.calls[0][0];
    expect(sent.brand_persona.brand_name).toBe('Glam by Riya');
    expect(sent.brand_persona.tone).toBe('formal');
    expect(sent.brand_persona.custom_instructions).toContain('Brides in Patna');
  });

  it('pauses the chat for a day only when a person must take over', async () => {
    const handoff = (reason: string) => ({
      public_reply: null,
      private_dm: 'Team aapko reply karegi',
      intent: 'human_handoff',
      sentiment: 'neutral',
      requires_human_attention: true,
      action: 'HANDOFF',
      handoff_reason: reason,
    });
    const dm = { ...req, eventType: 'dm' as const };

    const soft = make(handoff('missing_information'));
    await soft.engine.reply(dm);
    const softState = soft.prisma.conversation.update.mock.calls[0][0].data.goalState;
    expect(softState.handedOffUntil).toBeUndefined();

    const hard = make(handoff('human_request'));
    await hard.engine.reply(dm);
    const hardState = hard.prisma.conversation.update.mock.calls[0][0].data.goalState;
    expect(new Date(hardState.handedOffUntil).getTime()).toBeGreaterThan(Date.now());
  });

  it('creates a complete lead once every required detail is in', async () => {
    const { engine, leads, prisma } = make(
      {
        public_reply: null,
        private_dm: 'Noted! Artist aapko confirm karegi.',
        intent: 'booking',
        sentiment: 'positive',
        requires_human_attention: false,
        action: 'ASK_FIELD',
        offering_ids: ['o1'],
        collected_fields: { city: 'Patna', ignored: 'x' },
      },
      { aiEnabled: true, goalState: null },
    );
    // The context carries the date from an earlier message.
    (engine as any).context.build.mockResolvedValue({
      ...baseCtx,
      goal_state: { fields: { date: '2026-12-05' } },
    });
    await engine.reply({ ...req, eventType: 'dm' });
    const call = leads.upsertFromConversation.mock.calls[0][0];
    expect(call.fields).toEqual({ date: '2026-12-05', city: 'Patna' });
    expect(call.complete).toBe(true);
    expect(call.offeringId).toBe('o1');
    const saved = prisma.conversation.update.mock.calls[0][0].data.goalState;
    expect(saved.leadId).toBe('lead1');
  });
});

describe('post and page context', () => {
  const activeProfile = {
    industry: 'APPAREL',
    onboardedAt: new Date('2026-09-01'),
    activatedAt: new Date('2026-09-01'),
    services: ['COMMENT_REPLY', 'DM_REPLY'],
    businessName: 'Kurta Co',
    tone: 'friendly',
  };
  const ctx = (over: any = {}) => ({
    business: {},
    playbook: { goal: 'ORDER', lead_fields: [], rules: [] },
    offerings: [],
    post: null,
    style: { audience: null, tone: null, language: null },
    goal_state: {},
    recent_messages: [],
    allowed_prices: [],
    ...over,
  });
  const req = {
    orgId: 'org',
    brandName: 'B',
    platform: 'INSTAGRAM' as const,
    eventType: 'comment' as const,
    text: 'offer kya hai?',
    senderId: 's',
    postId: 'media1',
    channelId: 'ch1',
  };

  function engineWith(context: any, tagging?: any) {
    const prisma: any = {
      businessProfile: { findUnique: jest.fn().mockResolvedValue(activeProfile) },
    };
    const ai = { generateReply: jest.fn().mockResolvedValue({ private_dm: 'hi' }) };
    const engine = new ReplyEngineService(
      prisma,
      ai as any,
      { build: jest.fn().mockResolvedValue(context) } as any,
      {} as any,
      tagging,
    );
    return { engine, ai };
  }

  it("sends the post's caption and the seller's note to the AI", async () => {
    const { engine, ai } = engineWith(
      ctx({ post: { post_id: 'media1', caption: 'Aaj 20% off', note: 'Offer till Sunday' } }),
    );
    await engine.reply(req);
    expect(ai.generateReply.mock.calls[0][0].post_context).toEqual({
      post_id: 'media1',
      caption: 'Aaj 20% off',
      note: 'Offer till Sunday',
    });
  });

  it("uses the page's own tone over the business tone", async () => {
    const { engine, ai } = engineWith(
      ctx({ style: { audience: 'Brides', tone: 'formal', language: 'english' } }),
    );
    await engine.reply(req);
    const persona = ai.generateReply.mock.calls[0][0].brand_persona;
    expect(persona.tone).toBe('formal');
    expect(persona.language_mode).toBe('english');
    expect(persona.custom_instructions).toContain('Brides');
  });

  it('learns a new post before answering its comment, but not in a preview', async () => {
    const tagging = { ensurePostContext: jest.fn().mockResolvedValue(undefined) };
    const { engine } = engineWith(ctx(), tagging);
    await engine.reply(req);
    expect(tagging.ensurePostContext).toHaveBeenCalledWith('org', 'ch1', 'media1');
    tagging.ensurePostContext.mockClear();
    await engine.reply({ ...req, preview: true });
    expect(tagging.ensurePostContext).not.toHaveBeenCalled();
  });

  it('still replies when learning the post fails', async () => {
    const tagging = { ensurePostContext: jest.fn().mockRejectedValue(new Error('graph down')) };
    const { engine } = engineWith(ctx(), tagging);
    expect(await engine.reply(req)).not.toBeNull();
  });

  it('builds context from the page overrides and the stored caption', async () => {
    const prisma: any = {
      businessProfile: {
        findUnique: jest.fn().mockResolvedValue({
          industry: 'APPAREL',
          description: 'Kurtas for women',
          tone: 'friendly',
          faqs: [{ q: 'COD?', a: 'Yes' }],
        }),
      },
      pageProfile: {
        findFirst: jest.fn().mockResolvedValue({
          description: 'Bridal lehengas only',
          tone: 'formal',
          language: null,
          audience: null,
          faqs: [{ q: 'Trial?', a: 'Saturday' }],
          offeringIds: ['o1'],
        }),
      },
      socialPost: { findUnique: jest.fn().mockResolvedValue({ caption: 'New drop', note: 'Only size M left' }) },
      postOfferingLink: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
      offering: { findMany: jest.fn().mockResolvedValue([]) },
      inboxMessage: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const { ReplyContextService } = jest.requireActual('./reply-context.service');
    const service = new ReplyContextService(prisma, { availability: jest.fn() } as any);
    const built = await service.build({ orgId: 'org', text: 'lehenga', postId: 'p1', channelId: 'ch1' });
    expect(built.business.description).toBe('Bridal lehengas only');
    expect(built.business.faqs.map((f: any) => f.q)).toEqual(['Trial?', 'COD?']);
    expect(built.style).toEqual({ audience: null, tone: 'formal', language: null });
    expect(built.post).toEqual({ post_id: 'p1', caption: 'New drop', note: 'Only size M left' });
    // The page only sells o1, so the search is limited to it.
    expect(prisma.offering.findMany.mock.calls[0][0].where.id).toEqual({ in: ['o1'] });
  });
});

describe('PostTaggingService', () => {
  function make(over: any = {}) {
    const prisma: any = {
      socialPost: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
      channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch1', platform: 'INSTAGRAM' }) },
      businessProfile: {
        findUnique: jest.fn().mockResolvedValue({ autoTagPosts: true }),
        findMany: jest.fn().mockResolvedValue([{ orgId: 'a' }, { orgId: 'b' }]),
      },
      offering: { count: jest.fn().mockResolvedValue(3), findMany: jest.fn().mockResolvedValue([]) },
      postOfferingLink: {
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn(),
        create: jest.fn(),
      },
      postTagRun: { findFirst: jest.fn() },
      ...over,
    };
    const post = {
      id: 'media1',
      text: 'New kurta drop',
      mediaUrl: null,
      permalink: 'https://ig/p/1',
      likes: 1,
      commentsCount: 2,
    };
    const posts: any = { getPost: jest.fn().mockResolvedValue(post) };
    const gemini: any = { isConfigured: () => false };
    const context: any = { search: jest.fn().mockResolvedValue([]) };
    const meta: any = { sendWhatsAppImageButtons: jest.fn(), sendInteractiveButtonMessage: jest.fn() };
    const { PostTaggingService } = jest.requireActual('./post-tagging.service');
    const service = new PostTaggingService(prisma, posts, gemini, context, meta);
    return { service, prisma, posts };
  }

  it('fetches and tags a post the first time it is commented on', async () => {
    const { service, prisma, posts } = make();
    await service.ensurePostContext('org', 'ch1', 'media1');
    expect(posts.getPost).toHaveBeenCalledWith('org', 'ch1', 'media1');
    // Listed first (so a failed AI call still shows it), then marked tagged.
    const [listed, tagged] = prisma.socialPost.upsert.mock.calls.map((c: any) => c[0]);
    expect(listed.create).toMatchObject({ postId: 'media1', caption: 'New kurta drop', channelId: 'ch1', taggedAt: null });
    expect(tagged.update.taggedAt).toBeInstanceOf(Date);
  });

  it('still lists the post when the AI match fails', async () => {
    const { service, prisma } = make();
    prisma.offering.findMany.mockRejectedValue(new Error('Gemini down'));
    await expect(service.ensurePostContext('org', 'ch1', 'media1')).rejects.toThrow('Gemini down');
    expect(prisma.socialPost.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.socialPost.upsert.mock.calls[0][0].create).toMatchObject({ postId: 'media1', taggedAt: null });
  });

  it('with auto-match off, brings in every post without the AI or a catalog', async () => {
    const { service, prisma, posts } = make();
    prisma.businessProfile.findUnique.mockResolvedValue({ autoTagPosts: false });
    prisma.offering.count.mockResolvedValue(0);
    prisma.channel.findMany = jest.fn().mockResolvedValue([{ id: 'ch1', platform: 'INSTAGRAM' }]);
    prisma.postTagRun.create = jest.fn().mockResolvedValue({ id: 'run1' });
    prisma.postTagRun.update = jest.fn(async ({ data }: any) => data);
    posts.allPosts = jest.fn().mockResolvedValue(
      Array.from({ length: 15 }, (_, i) => ({ id: `m${i}`, text: '', mediaUrl: null, permalink: null, createdAt: '2026-09-01T10:00:00+0000', likes: i, commentsCount: 0 })),
    );
    const run = await service.run('org');
    expect(run).toMatchObject({ status: 'DONE', postsSeen: 15, suggested: 0 });
    expect(prisma.socialPost.upsert).toHaveBeenCalledTimes(15);
    expect(prisma.socialPost.upsert.mock.calls[0][0].create).toMatchObject({ postedAt: new Date('2026-09-01T10:00:00Z'), likes: 0 });
    expect(prisma.postOfferingLink.create).not.toHaveBeenCalled();
  });

  it('lists posts newest first, 10 per page, with the total', async () => {
    const { service, prisma } = make();
    prisma.postOfferingLink.findMany = jest.fn().mockResolvedValue([]);
    prisma.dmSpotlight = { findMany: jest.fn().mockResolvedValue([]) };
    prisma.commentReplyJob = { findMany: jest.fn().mockResolvedValue([]) };
    prisma.socialPost.findMany.mockResolvedValue(
      Array.from({ length: 23 }, (_, i) => ({
        postId: `m${i}`,
        platform: 'INSTAGRAM',
        postedAt: new Date(Date.UTC(2026, 0, 1 + i)),
        createdAt: new Date('2026-09-28T00:00:00Z'),
        note: null,
        source: 'META',
      })),
    );
    prisma.businessProfile.findUnique.mockResolvedValue({ autoTagPosts: false });
    const first = await service.listLinks('org', undefined, undefined, { page: 1 });
    expect(first).toMatchObject({ total: 23, page: 1, limit: 10, autoTagPosts: false });
    expect(first.posts.map((p: any) => p.postId).slice(0, 2)).toEqual(['m22', 'm21']);
    const last = await service.listLinks('org', undefined, undefined, { page: 3, limit: 10 });
    expect(last.posts.map((p: any) => p.postId)).toEqual(['m2', 'm1', 'm0']);
    expect((await service.listLinks('org')).posts).toHaveLength(23);
  });

  it('does nothing for a post it already knows', async () => {
    const { service, prisma, posts } = make();
    prisma.socialPost.findUnique.mockResolvedValue({ taggedAt: new Date() });
    await service.ensurePostContext('org', 'ch1', 'media1');
    expect(posts.getPost).not.toHaveBeenCalled();
  });

  it('only stores the caption when auto-tagging is off', async () => {
    const { service, prisma } = make();
    prisma.businessProfile.findUnique.mockResolvedValue({ autoTagPosts: false });
    await service.ensurePostContext('org', 'ch1', 'media1');
    expect(prisma.socialPost.upsert.mock.calls[0][0].create.taggedAt).toBeNull();
  });

  it('runs the daily tagging from the last saved run, not a timer', async () => {
    const { service, prisma } = make();
    const now = new Date('2026-09-28T12:00:00Z');
    prisma.postTagRun.findFirst.mockImplementation(async ({ where }: any) =>
      where.orgId === 'a' ? { createdAt: new Date('2026-09-28T02:00:00Z') } : { createdAt: new Date('2026-09-26T00:00:00Z') },
    );
    const run = jest.spyOn(service, 'run').mockResolvedValue({} as any);
    expect(await service.runDue(now)).toBe(1);
    expect(run).toHaveBeenCalledWith('b');
  });
});

describe('onboarding', () => {
  it('lists what is missing before automation can start', () => {
    expect(missingForActivation(null)).toEqual([
      'businessName',
      'description',
      'services',
    ]);
    expect(
      missingForActivation({
        businessName: 'Glam by Riya',
        description: 'Bridal and party makeup artist in Patna, home visits too',
        services: ['DM_REPLY'],
      }),
    ).toEqual([]);
    expect(
      missingForActivation({
        businessName: 'X',
        description: 'too short',
        services: ['NOPE'],
      }),
    ).toEqual(['description', 'services']);
  });

  it('maps each event to the service it needs', () => {
    expect(serviceFor('INSTAGRAM', 'comment')).toBe('COMMENT_REPLY');
    expect(serviceFor('FACEBOOK', 'dm')).toBe('DM_REPLY');
    expect(serviceFor('WHATSAPP', 'dm')).toBe('WHATSAPP_REPLY');
  });
});
