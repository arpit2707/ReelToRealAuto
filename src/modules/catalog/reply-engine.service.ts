import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AiClientService,
  type GeneratedReplyResult,
} from '../ai-client/ai-client.service';
import { ReplyContextService, type GoalState } from './reply-context.service';
import { LeadsService } from './leads.service';
import { unknownPrices } from './price-guard';
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
  // A seller trying the AI from the dashboard; works before onboarding too.
  preview?: boolean;
};

export type ReplyOutcome = GeneratedReplyResult & {
  offering_ids: string[];
  action: NonNullable<GeneratedReplyResult['action']>;
  // True when the price guard replaced what the AI wrote.
  guarded: boolean;
  leadId?: string;
};

const HANDOFF_PAUSE_MS = 24 * 60 * 60 * 1000;

// The AI could not answer for a technical reason (service down, model error).
// That is no reason to keep the chat silent for a day; the next message retries.
function technicalFailure(outcome: GeneratedReplyResult): boolean {
  return (
    outcome.intent === 'ai_unavailable' ||
    outcome.handoff_reason === 'generation_unavailable'
  );
}

const SAFE_DM =
  'Thank you! Iski exact price aur details hamari team aapko thodi der me bhej degi.';
const SAFE_PUBLIC = 'Thank you! Details DM me bhej di hain.';

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
  ) {}

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

    if (req.conversationId) {
      const convo = await this.prisma.conversation.findUnique({
        where: { id: req.conversationId },
        select: { aiEnabled: true, goalState: true },
      });
      // A seller who turned the AI off, or a chat just handed to a person,
      // gets no automatic answers. A hand-off pauses for a day at most, so a
      // chat nobody picked up does not stay silent forever.
      const until = (convo?.goalState as GoalState | null)?.handedOffUntil;
      if (
        convo &&
        (!convo.aiEnabled || (until && new Date(until) > new Date()))
      )
        return null;
    }

    const ctx = await this.context.build({
      orgId: req.orgId,
      text: req.text,
      postId: req.postId,
      conversationId: req.conversationId,
    });

    const ai = await this.aiClient.generateReply({
      brand_id: req.orgId,
      channel_type: req.platform.toLowerCase(),
      event_type: req.eventType,
      message_text: req.text,
      sender_id: req.senderId,
      ...(req.postId ? { post_context: { post_id: req.postId } } : {}),
      brand_persona: {
        brand_name: profile?.businessName || req.brandName,
        ...((profile?.tone || profile?.replyTone) &&
        TONES.includes((profile?.tone || profile?.replyTone) as string)
          ? { tone: (profile?.tone || profile?.replyTone) as string }
          : {}),
        ...((profile?.language || profile?.replyLanguage) &&
        LANGUAGES.includes((profile?.language || profile?.replyLanguage) as string)
          ? { language_mode: (profile?.language || profile?.replyLanguage) as string }
          : {}),
        ...(styleNotes(profile)
          ? { custom_instructions: styleNotes(profile) as string }
          : {}),
      },
      business: ctx.business,
      playbook: ctx.playbook,
      offerings: ctx.offerings,
      goal_state: ctx.goal_state as Record<string, unknown>,
      recent_messages: ctx.recent_messages,
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

    if (req.conversationId) {
      await this.remember(
        req,
        ctx.goal_state,
        ctx.playbook.lead_fields.map((f) => f.key),
        ctx.playbook.goal,
        outcome,
      );
    }
    return outcome;
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
    const next: GoalState = {
      ...previous,
      offeringIds: outcome.offering_ids.length
        ? outcome.offering_ids
        : previous.offeringIds,
      fields: { ...(previous.fields || {}), ...collected },
      ...(outcome.action === 'HANDOFF' && !technicalFailure(outcome)
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
