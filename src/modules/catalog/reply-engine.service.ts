import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AiClientService,
  type GeneratedReplyResult,
} from '../ai-client/ai-client.service';
import { ReplyContextService, type GoalState } from './reply-context.service';
import { LeadsService } from './leads.service';
import { PostTaggingService } from './post-tagging.service';
import { PostAiGateService } from './post-ai-gate.service';
import { unknownPrices } from './price-guard';
import { CRISIS_PUBLIC, crisisReply, isCrisis, receivedReply } from './crisis';
import {
  replyBlockedReason,
  automationBlock,
  serviceFor,
  TONES,
  LANGUAGES,
} from './onboarding';

export type ReplyRequest = {
  orgId: string;
  brandName: string;
  platform: 'INSTAGRAM' | 'FACEBOOK' | 'WHATSAPP';
  eventType: 'comment' | 'dm';
  text: string;
  senderId: string;
  senderName?: string | null;
  postId?: string | null;
  conversationId?: string | null;
  // Channel.id the message came in on; picks that page's own context.
  channelId?: string | null;
  // A seller trying the AI from the dashboard; works before onboarding too.
  preview?: boolean;
  // Who a public comment reply answers; the queue adds the @tag itself.
  commentAuthor?: string | null;
};

// A comment on a brand-new post waits this long for the post to be matched to
// the catalog; after that the reply goes out with what is known.
const POST_CONTEXT_WAIT_MS = 8000;

export type ReplyOutcome = GeneratedReplyResult & {
  offering_ids: string[];
  action: NonNullable<GeneratedReplyResult['action']>;
  // True when the price guard replaced what the AI wrote.
  guarded: boolean;
  leadId?: string;
};

const HANDOFF_PAUSE_MS = 24 * 60 * 60 * 1000;

// Only these hand the chat to a person for a day. Anything else the AI could
// not answer (a price not in the catalog, a model hiccup) gets the "team will
// reply" message, but the next customer message is answered normally again.
// A crisis turns the chat's AI off until the seller turns it back on.
export const PAUSING_REASONS = [
  'human_request',
  'complaint',
  'order_support',
  'purchase_assistance',
  'unresolved_query',
  'crisis',
];

/**
 * Where the conversation is: DISCOVER (finding out what they want) -> QUOTE
 * (items and prices shown) -> COLLECT (asking lead details) -> DONE (lead in).
 * It never moves backwards on a hiccup such as a hand-off.
 */
export function nextStage(
  previous: string | undefined,
  outcome: { action?: string | null; offering_ids?: string[] | null },
  hasFields: boolean,
): string {
  const order = ['DISCOVER', 'QUOTE', 'COLLECT', 'DONE'];
  let stage = 'DISCOVER';
  if (outcome.action === 'CREATE_LEAD') stage = 'DONE';
  else if (outcome.action === 'ASK_FIELD' || hasFields) stage = 'COLLECT';
  else if (outcome.action === 'SEND_LINK' || (outcome.offering_ids || []).length) stage = 'QUOTE';
  const prev = order.indexOf(previous || 'DISCOVER');
  return order[Math.max(prev, order.indexOf(stage))];
}

/** True while the AI must stay quiet in this chat. */
export function chatPaused(
  convo: { aiEnabled: boolean; goalState: unknown } | null | undefined,
  now = new Date(),
): boolean {
  if (!convo) return false;
  const s = (convo.goalState as GoalState | null) || {};
  const future = (iso?: string) => Boolean(iso && new Date(iso) > now);
  return (
    !convo.aiEnabled || future(s.handedOffUntil) || future(s.sellerPausedUntil)
  );
}

const SAFE_DM =
  'Thank you! Iski exact price aur details hamari team aapko thodi der me bhej degi.';
// Never claims a DM: the comment queue adds "DM check karein" only when one went.
const SAFE_PUBLIC = 'Thank you! Team jaldi details share karegi.';

// The catalog prompt reads only custom_instructions for style, so the setup
// answers are spelled out there as well.
function styleNotes(
  p: { audience?: string | null; tone?: string | null; language?: string | null } | null,
): string | null {
  const notes: string[] = [];
  if (p?.audience) notes.push(`Customers are mostly: ${p.audience}.`);
  if (p?.tone) notes.push(`Tone: ${p.tone.replace('_', ' ')}.`);
  if (p?.language && p.language !== 'auto')
    notes.push(`Prefer ${p.language} unless the customer writes otherwise.`);
  return notes.length ? notes.join(' ') : null;
}

/**
 * Every automated reply goes through here: it builds the catalog context, asks
 * the AI service, refuses any price that is not in the catalog, remembers what
 * the customer has told us, and turns a finished conversation into a lead.
 */
@Injectable()
export class ReplyEngineService {
  private readonly logger = new Logger(ReplyEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiClient: AiClientService,
    private readonly context: ReplyContextService,
    private readonly leads: LeadsService,
    @Optional() private readonly tagging?: PostTaggingService,
    @Optional() private readonly gate?: PostAiGateService,
  ) {}

  /** Learns a new post's caption and item before replying to its first comments. */
  private async ensurePostContext(req: ReplyRequest) {
    if (!this.tagging || !req.postId || !req.channelId || req.platform === 'WHATSAPP') return;
    let timer: NodeJS.Timeout | undefined;
    const work = this.tagging
      .ensurePostContext(req.orgId, req.channelId, req.postId)
      .catch((e) => this.logger.warn(`Post context for ${req.postId} failed: ${e.message}`));
    await Promise.race([
      work,
      new Promise((r) => {
        timer = setTimeout(r, POST_CONTEXT_WAIT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  async reply(
    req: ReplyRequest,
    opts: { preview?: boolean } = {},
  ): Promise<ReplyOutcome | null> {
    const isPreview = Boolean(req.preview || opts.preview);
    const profile = await this.prisma.businessProfile.findUnique({
      where: { orgId: req.orgId },
    });
    const blocked = replyBlockedReason(
      profile,
      serviceFor(req.platform, req.eventType),
    );
    if (blocked && !isPreview) {
      this.logger.log(
        `No automated ${req.platform} ${req.eventType} reply for org ${req.orgId}: ${blocked}`,
      );
      return null;
    }

    const convo = req.conversationId
      ? await this.prisma.conversation.findUnique({
          where: { id: req.conversationId },
          select: { aiEnabled: true, goalState: true },
        })
      : null;
    const state = ((convo?.goalState as GoalState | null) || {}) as GoalState;

    // Safety before everything else, even a paused chat or a post with the AI
    // off: helplines once, then the chat waits for the seller.
    if (isCrisis(req.text)) return this.crisis(req, convo, state, isPreview);

    // A seller who turned the AI off, a chat just handed to a person, or one
    // the seller answered themselves gets no automatic answers. Pauses expire
    // (a day for a hand-off, 12 hours after a seller reply), so a chat nobody
    // picked up does not stay silent forever.
    if (chatPaused(convo)) return null;

    // Comments are answered only on posts the seller switched the AI on for
    // (decision 2). The dashboard preview can try any post.
    if (
      req.eventType === 'comment' &&
      !isPreview &&
      this.gate &&
      !(await this.gate.isPostAiOn(req.orgId, req.postId))
    ) {
      this.logger.log(`No comment reply for org ${req.orgId}: AI is off for post ${req.postId}`);
      // Still learn the post (and ask the seller about its item) in the background.
      if (this.tagging && req.postId && req.channelId)
        void this.tagging
          .ensurePostContext(req.orgId, req.channelId, req.postId)
          .catch((e) => this.logger.warn(`Post context for ${req.postId} failed: ${e.message}`));
      return null;
    }

    if (!isPreview) await this.ensurePostContext(req);

    const ctx = await this.context.build({
      orgId: req.orgId,
      text: req.text,
      postId: req.postId,
      conversationId: req.conversationId,
      channelId: req.channelId,
    });
    // The post the context settled on (AI-on posts only); older test doubles
    // only carry `post`.
    const postId = ctx.post_id !== undefined ? ctx.post_id : ctx.post?.post_id || null;
    // The page's own style when it has one, else the business profile's.
    const style = {
      audience: ctx.style?.audience ?? profile?.audience ?? null,
      tone: ctx.style?.tone ?? profile?.tone ?? profile?.replyTone ?? null,
      language:
        ctx.style?.language ?? profile?.language ?? profile?.replyLanguage ?? null,
    };

    const ai = await this.aiClient.generateReply({
      brand_id: req.orgId,
      channel_type: req.platform.toLowerCase(),
      event_type: req.eventType,
      message_text: req.text,
      sender_id: req.senderId,
      ...(postId
        ? {
            post_context: {
              post_id: postId,
              ...(ctx.post?.caption ? { caption: ctx.post.caption } : {}),
              ...(ctx.post?.note ? { note: ctx.post.note } : {}),
            },
          }
        : {}),
      brand_persona: {
        brand_name: profile?.businessName || req.brandName,
        ...(style.tone && TONES.includes(style.tone) ? { tone: style.tone } : {}),
        ...(style.language && LANGUAGES.includes(style.language)
          ? { language_mode: style.language }
          : {}),
        ...(styleNotes(style)
          ? { custom_instructions: styleNotes(style) as string }
          : {}),
      },
      business: ctx.business,
      playbook: ctx.playbook,
      offerings: ctx.offerings,
      goal_state: ctx.goal_state as Record<string, unknown>,
      recent_messages: ctx.recent_messages,
      ...(req.eventType === 'comment' && req.commentAuthor
        ? { comment_author: req.commentAuthor }
        : {}),
      resume_if_pending: true,
    });

    const outcome: ReplyOutcome = {
      ...ai,
      offering_ids: (ai.offering_ids || []).filter((id) =>
        ctx.offerings.some((o) => o.id === id),
      ),
      action: ai.action || (ai.requires_human_attention ? 'HANDOFF' : 'ANSWER'),
      guarded: false,
    };

    const badPublic = outcome.public_reply
      ? unknownPrices(outcome.public_reply, ctx.allowed_prices, req.text)
      : [];
    const badDm = outcome.private_dm
      ? unknownPrices(outcome.private_dm, ctx.allowed_prices, req.text)
      : [];
    if (badPublic.length || badDm.length) {
      this.logger.warn(
        `Blocked reply for org ${req.orgId}: prices ${[...badPublic, ...badDm].join(', ')} are not in the catalog`,
      );
      outcome.guarded = true;
      outcome.requires_human_attention = true;
      outcome.action = 'HANDOFF';
      outcome.private_dm = SAFE_DM;
      outcome.public_reply = req.eventType === 'comment' ? SAFE_PUBLIC : null;
    }

    if (outcome.intent === 'ai_unavailable') {
      // One "we got your message" per outage, only in a DM chat; comments
      // stay unanswered rather than getting a public line with nothing behind it.
      const notify =
        req.eventType === 'dm' && Boolean(req.conversationId) && !state.aiDownNoticeAt;
      outcome.private_dm = notify ? receivedReply(req.text) : null;
      outcome.public_reply = null;
      outcome.action = 'HANDOFF';
      outcome.handoff_reason = 'ai_unavailable';
    }

    // The same "team will confirm" line twice in a row reads like a stuck bot.
    const soft =
      outcome.action === 'HANDOFF' &&
      !PAUSING_REASONS.includes(outcome.handoff_reason || '');
    const lastBusiness = [...ctx.recent_messages]
      .reverse()
      .find((m) => m.from === 'business');
    if (
      soft &&
      outcome.private_dm &&
      lastBusiness &&
      lastBusiness.text === outcome.private_dm.slice(0, 300)
    ) {
      outcome.private_dm = null;
    }

    if (req.conversationId) {
      await this.remember(
        req,
        {
          ...ctx.goal_state,
          // A post mentioned now starts (or restarts) the 7-day memory.
          ...(postId && req.postId === postId
            ? { postId, postAt: new Date().toISOString() }
            : {}),
        },
        ctx.playbook.lead_fields.map((f) => f.key),
        ctx.playbook.goal,
        outcome,
      );
    }
    return outcome;
  }

  private async crisis(
    req: ReplyRequest,
    convo: { aiEnabled: boolean; goalState: unknown } | null,
    state: GoalState,
    isPreview: boolean,
  ): Promise<ReplyOutcome | null> {
    // Once per chat: after the helpline the AI stays off until the seller
    // switches it back on (which clears crisisAt).
    if (convo && state.crisisAt && !convo.aiEnabled) return null;
    this.logger.warn(
      `Crisis message for org ${req.orgId} on ${req.platform} ${req.eventType}; sending helplines and pausing the AI`,
    );
    if (req.conversationId && !isPreview) {
      await this.prisma.conversation
        .update({
          where: { id: req.conversationId },
          data: {
            aiEnabled: false,
            goalState: {
              ...state,
              handoffReason: 'crisis',
              crisisAt: new Date().toISOString(),
            } as Prisma.InputJsonValue,
          },
        })
        .catch((e) =>
          this.logger.error(`Could not pause the chat after a crisis message: ${e.message}`),
        );
    }
    return {
      public_reply: req.eventType === 'comment' ? CRISIS_PUBLIC : null,
      private_dm: crisisReply(req.text),
      intent: 'crisis',
      sentiment: 'negative',
      requires_human_attention: true,
      handoff_reason: 'crisis',
      action: 'HANDOFF',
      offering_ids: [],
      guarded: false,
    };
  }

  private async remember(
    req: ReplyRequest,
    previous: GoalState,
    leadKeys: string[],
    goal: string,
    outcome: ReplyOutcome,
  ) {
    const collected = Object.fromEntries(
      Object.entries(outcome.collected_fields || {})
        .filter(
          ([k, v]) => leadKeys.includes(k) && typeof v === 'string' && v.trim(),
        )
        .map(([k, v]) => [k, String(v).trim().slice(0, 120)]),
    );
    const fields = { ...(previous.fields || {}), ...collected };
    const next: GoalState = {
      ...previous,
      offeringIds: outcome.offering_ids.length
        ? outcome.offering_ids
        : previous.offeringIds,
      fields,
      ...(outcome.offering_type === 'PRODUCTS' || outcome.offering_type === 'SERVICES'
        ? { offeringType: outcome.offering_type }
        : {}),
      stage: nextStage(previous.stage, outcome, Object.keys(fields).length > 0),
      // Shown as "Needs you" in the inbox until the seller replies or resumes.
      ...(outcome.action === 'HANDOFF'
        ? {
            handoffReason:
              outcome.handoff_reason ||
              (outcome.guarded ? 'price_blocked' : 'missing_information'),
          }
        : {}),
      aiDownNoticeAt:
        outcome.intent === 'ai_unavailable'
          ? previous.aiDownNoticeAt ||
            (outcome.private_dm ? new Date().toISOString() : undefined)
          : undefined,
      ...(outcome.action === 'HANDOFF' &&
      !outcome.guarded &&
      PAUSING_REASONS.includes(outcome.handoff_reason || '')
        ? {
            handedOffUntil: new Date(
              Date.now() + HANDOFF_PAUSE_MS,
            ).toISOString(),
          }
        : {}),
    };

    const complete =
      leadKeys.length > 0 && leadKeys.every((k) => next.fields?.[k]);
    const wantsLead =
      goal !== 'ORDER' &&
      (outcome.action === 'CREATE_LEAD' ||
        complete ||
        Object.keys(collected).length > 0);
    if (wantsLead) {
      const lead = await this.leads
        .upsertFromConversation({
          orgId: req.orgId,
          conversationId: req.conversationId!,
          offeringId: next.offeringIds?.[0] || null,
          platform: req.platform,
          contactName: req.senderName,
          contactHandle: req.senderId,
          fields: next.fields || {},
          complete: complete || outcome.action === 'CREATE_LEAD',
        })
        .catch((e) => {
          this.logger.error(`Lead upsert failed: ${e.message}`);
          return null;
        });
      if (lead) {
        next.leadId = lead.id;
        outcome.leadId = lead.id;
      }
    }

    await this.prisma.conversation
      .update({
        where: { id: req.conversationId! },
        data: { goalState: next as Prisma.InputJsonValue },
      })
      .catch((e) =>
        this.logger.error(`Could not save goal state: ${e.message}`),
      );
  }
}
