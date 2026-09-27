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
