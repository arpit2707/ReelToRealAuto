import { ReplyEngineService, chatPaused } from './reply-engine.service';
import { isCrisis, crisisReply, languageOf, CRISIS_PUBLIC } from './crisis';
import { InboxService } from '../inbox/inbox.service';

describe('crisis detection', () => {
  it.each([
    'I want to kill myself',
    'thinking about suicide',
    "i don't want to live anymore",
    'mujhe marna hai',
    'jeena nahi hai ab',
    'zeher kha lungi',
    'khud ko khatam kar dunga',
    'मुझे मरना है',
    'आत्महत्या',
  ])('flags %s', (text) => expect(isCrisis(text)).toBe(true));

  it.each(['killer look!', 'price kya hai', 'dying to buy this', 'mar gaye itna sundar', 'to die for'])(
    'ignores %s',
    (text) => expect(isCrisis(text)).toBe(false),
  );

  it('answers in the customer language', () => {
    expect(languageOf('I want to die')).toBe('english');
    expect(languageOf('mujhe marna hai')).toBe('hinglish');
    expect(crisisReply('मुझे मरना है')).toContain('टेली-मानस');
    expect(crisisReply('I want to die')).toContain('14416');
  });
});

describe('ReplyEngineService safety and pauses', () => {
  const profile = {
    industry: 'APPAREL',
    onboardedAt: new Date('2026-09-01'),
    services: ['DM_REPLY', 'COMMENT_REPLY', 'WHATSAPP_REPLY'],
  };
  const ctx = {
    business: {},
    playbook: { goal: 'ORDER', lead_fields: [], rules: [] },
    offerings: [],
    goal_state: {},
    recent_messages: [] as Array<{ from: string; text: string }>,
    allowed_prices: [],
  };
  const req = {
    orgId: 'org',
    brandName: 'B',
    platform: 'INSTAGRAM' as const,
    eventType: 'dm' as const,
    text: 'price?',
    senderId: 's',
    conversationId: 'c1',
  };

  function make(ai: any, convo: any = { aiEnabled: true, goalState: null }, context: any = ctx) {
    const prisma: any = {
      businessProfile: { findUnique: jest.fn().mockResolvedValue(profile) },
      conversation: {
        findUnique: jest.fn().mockResolvedValue(convo),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const aiClient = { generateReply: jest.fn().mockResolvedValue(ai) };
    const engine = new ReplyEngineService(
      prisma,
      aiClient as any,
      { build: jest.fn().mockResolvedValue(context) } as any,
      { upsertFromConversation: jest.fn() } as any,
    );
    return { engine, prisma, aiClient };
  }

  it('sends helplines before calling the AI and turns the chat AI off', async () => {
    const { engine, prisma, aiClient } = make({ private_dm: 'no' });
    const out = await engine.reply({ ...req, text: 'mujhe marna hai' });
    expect(out?.private_dm).toContain('14416');
    expect(out?.handoff_reason).toBe('crisis');
    expect(aiClient.generateReply).not.toHaveBeenCalled();
    const data = prisma.conversation.update.mock.calls[0][0].data;
    expect(data.aiEnabled).toBe(false);
    expect(data.goalState.handoffReason).toBe('crisis');
    expect(data.goalState.crisisAt).toBeTruthy();
  });

  it('sends helplines only once per chat', async () => {
    const { engine } = make({}, {
      aiEnabled: false,
      goalState: { crisisAt: '2026-09-28T00:00:00Z', handoffReason: 'crisis' },
    });
    expect(await engine.reply({ ...req, text: 'I want to die' })).toBeNull();
  });

  it('answers a crisis comment publicly with a short line only', async () => {
    const { engine } = make({});
    const out = await engine.reply({ ...req, eventType: 'comment', conversationId: null, text: 'suicide' });
    expect(out?.public_reply).toBe(CRISIS_PUBLIC);
    expect(out?.private_dm).toContain('112');
  });

  it('crisis beats a chat the seller paused', async () => {
    const { engine } = make({}, { aiEnabled: false, goalState: null });
    const out = await engine.reply({ ...req, text: 'I want to kill myself' });
    expect(out?.intent).toBe('crisis');
  });

  it('stays quiet for 12 hours after the seller replied', async () => {
    const until = new Date(Date.now() + 60_000).toISOString();
    const { engine, aiClient } = make({ private_dm: 'hi' }, { aiEnabled: true, goalState: { sellerPausedUntil: until } });
    expect(await engine.reply(req)).toBeNull();
    expect(aiClient.generateReply).not.toHaveBeenCalled();
  });

  it('pauses for unresolved queries too', async () => {
    const { engine, prisma } = make({
      private_dm: 'Sorry',
      requires_human_attention: true,
      action: 'HANDOFF',
      handoff_reason: 'unresolved_query',
    });
    await engine.reply(req);
    const saved = prisma.conversation.update.mock.calls[0][0].data.goalState;
    expect(saved.handedOffUntil).toBeTruthy();
    expect(saved.handoffReason).toBe('unresolved_query');
  });

  it('says "message mil gaya" once while the AI service is down', async () => {
    const down = { public_reply: null, private_dm: null, intent: 'ai_unavailable', requires_human_attention: true };
    const first = make(down);
    const out = await first.engine.reply({ ...req, text: 'size kya hai?' });
    expect(out?.private_dm).toContain('mil gaya');
    const saved = first.prisma.conversation.update.mock.calls[0][0].data.goalState;
    expect(saved.aiDownNoticeAt).toBeTruthy();
    expect(saved.handedOffUntil).toBeUndefined();

    const second = make(down, { aiEnabled: true, goalState: saved });
    expect((await second.engine.reply(req))?.private_dm).toBeNull();
  });

  it('never sends the same soft line twice in a row', async () => {
    const line = 'Accha sawaal! Team ise confirm karke aapko yahin batayegi.';
    const { engine } = make(
      { private_dm: line, action: 'HANDOFF', handoff_reason: 'missing_information', requires_human_attention: true },
      undefined,
      { ...ctx, recent_messages: [{ from: 'business', text: line }] },
    );
    expect((await engine.reply(req))?.private_dm).toBeNull();
  });

  it('chatPaused covers every pause', () => {
    const future = new Date(Date.now() + 1000).toISOString();
    const past = new Date(Date.now() - 1000).toISOString();
    expect(chatPaused({ aiEnabled: false, goalState: null })).toBe(true);
    expect(chatPaused({ aiEnabled: true, goalState: { handedOffUntil: future } })).toBe(true);
    expect(chatPaused({ aiEnabled: true, goalState: { sellerPausedUntil: future } })).toBe(true);
    expect(chatPaused({ aiEnabled: true, goalState: { sellerPausedUntil: past } })).toBe(false);
  });
});

describe('InboxService seller reply and resume', () => {
  const channel = {
    id: 'ch',
    platform: 'INSTAGRAM',
    channelIdentifier: 'ig',
    name: 'IG',
    isActive: true,
    status: 'ACTIVE',
    accessTokenEncrypted: 'enc',
  };
  function build(goalState: any) {
    const conversation = {
      id: 'c1',
      orgId: 'org',
      aiEnabled: false,
      goalState,
      channel,
      contact: { platformUserId: 'u1' },
      windowExpiresAt: null,
    };
    const prisma: any = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue(conversation),
        update: jest.fn(async ({ data }) => ({ ...conversation, ...data })),
      },
    };
    const service = new InboxService(
      prisma,
      { decrypt: () => 'tok' } as any,
      { sendPrivateDm: jest.fn().mockResolvedValue(true) } as any,
      { ingestOutbound: jest.fn() } as any,
      { inboxChanged: jest.fn() } as any,
    );
    return { service, prisma };
  }

  it('pauses the AI for 12 hours when the seller replies', async () => {
    const { service, prisma } = build({ handoffReason: 'missing_information' });
    await service.reply({ sub: 'u', orgId: 'org', role: 'OWNER', email: 'a@b.c' } as any, 'INSTAGRAM', 'c1', 'Haan hai');
    const saved = prisma.conversation.update.mock.calls[0][0].data.goalState;
    const hours = (new Date(saved.sellerPausedUntil).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(11.9);
    expect(hours).toBeLessThanOrEqual(12);
    expect(saved.handoffReason).toBeUndefined();
  });

  it('Resume AI clears crisis, hand-off and seller pauses', async () => {
    const { service, prisma } = build({
      crisisAt: 'x',
      handoffReason: 'crisis',
      handedOffUntil: 'x',
      sellerPausedUntil: 'x',
      fields: { city: 'Patna' },
    });
    await service.setAi('org', 'c1', true);
    const data = prisma.conversation.update.mock.calls[0][0].data;
    expect(data.aiEnabled).toBe(true);
    expect(data.goalState).toEqual({ fields: { city: 'Patna' } });
  });
});
