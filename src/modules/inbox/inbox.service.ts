import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { MetaPublisherService } from '../meta-publisher/meta-publisher.service';
import { ConversationService } from '../conversations/conversation.service';
import { RealtimeService } from '../realtime/realtime.service';
import type { JwtPayload } from '../auth/jwt';
import { chatPaused, PAUSING_REASONS } from '../catalog/reply-engine.service';
import { POST_MEMORY_MS, type GoalState } from '../catalog/reply-context.service';
import { priceLabel } from '../catalog/industries';

// After the seller answers a chat themselves, the AI stays out of it this long.
export const SELLER_REPLY_PAUSE_MS = 12 * 60 * 60 * 1000;

@Injectable()
export class InboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly metaPublisher: MetaPublisherService,
    private readonly conversations: ConversationService,
    private readonly realtime: RealtimeService,
  ) {}

  async listChannels(orgId: string) {
    return this.prisma.channel.findMany({
      where: { orgId, isActive: true, status: { not: 'DISCONNECTED' } },
      orderBy: { platform: 'asc' },
      select: {
        id: true,
        platform: true,
        name: true,
        channelIdentifier: true,
        status: true,
        handle: true,
      },
    });
  }

  // What the automation saw and answered: comments and DMs across channels.
  async listActivity(orgId: string) {
    const rows = await this.prisma.interactionLog.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => ({
      id: r.id,
      platform: r.channelType,
      eventType: r.eventType,
      senderId: r.senderId,
      inbound: r.inboundMessage,
      publicReply: r.publicReply,
      privateDm: r.privateDm,
      intent: r.intent,
      requiresHuman: r.requiresHuman,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async listThreads(orgId: string, platform: string) {
    const rows = await this.prisma.conversation.findMany({
      where: { orgId, channel: { platform: platform.toUpperCase() } },
      include: {
        contact: true,
        channel: true,
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { lastInboundAt: { sort: 'desc', nulls: 'last' } },
      take: 100,
    });
    const sources = await this.sources(orgId, rows);
    return rows.map((c) => {
      const state = (c.goalState as GoalState | null) || {};
      const reason = state.handoffReason || null;
      return {
        id: c.id,
        senderId: c.contact.platformUserId,
        name: c.contact.name || c.contact.platformUserId,
        preview: c.messages[0]?.body || '',
        platform: c.channel.platform,
        status: c.status,
        lastAt: (c.lastInboundAt || c.updatedAt).toISOString(),
        windowExpiresAt: c.windowExpiresAt,
        aiPaused: aiPaused(c),
        // Crisis, complaint, a person asked for, or a question the AI could
        // not answer: cleared when the seller replies or resumes the AI.
        needsYou: Boolean(reason && PAUSING_REASONS.includes(reason)),
        handoffReason: reason,
        pauseReason: pauseReason(c),
        source: sources.get(c.id) || null,
      };
    });
  }

  /**
   * The post each chat is about (its first comment, story reply, share or ad,
   * or the post it talked about in the last 7 days): thumbnail and items.
   */
  private async sources(
    orgId: string,
    rows: Array<{
      id: string;
      goalState: unknown;
      sourcePostId?: string | null;
      sourcePlatform?: string | null;
      sourceKind?: string | null;
    }>,
  ) {
    const now = Date.now();
    const picked = new Map<string, { postId: string; kind: string | null; platform: string | null }>();
    for (const c of rows) {
      const s = (c.goalState as GoalState | null) || {};
      const fresh = s.postId && s.postAt && now - new Date(s.postAt).getTime() < POST_MEMORY_MS;
      const postId = fresh ? s.postId : c.sourcePostId;
      if (postId)
        picked.set(c.id, {
          postId,
          kind: postId === c.sourcePostId ? c.sourceKind || null : null,
          platform: c.sourcePlatform || null,
        });
    }
    const ids = [...new Set([...picked.values()].map((p) => p.postId))];
    if (!ids.length) return new Map();
    const [posts, links] = await Promise.all([
      this.prisma.socialPost.findMany({
        where: { orgId, postId: { in: ids } },
        select: { postId: true, caption: true, mediaUrl: true, permalink: true, platform: true },
      }),
      this.prisma.postOfferingLink.findMany({
        where: { orgId, postId: { in: ids }, status: 'SELLER_CONFIRMED' },
        select: {
          postId: true,
          mediaUrl: true,
          permalink: true,
          caption: true,
          offering: {
            select: {
              id: true,
              title: true,
              priceMode: true,
              priceMin: true,
              priceMax: true,
              currency: true,
              isActive: true,
            },
          },
        },
      }),
    ]);
    const post = new Map(posts.map((p) => [p.postId, p]));
    const out = new Map<string, Record<string, unknown>>();
    for (const [conversationId, ref] of picked) {
      const sp = post.get(ref.postId);
      const own = links.filter((l) => l.postId === ref.postId);
      out.set(conversationId, {
        postId: ref.postId,
        kind: ref.kind,
        platform: sp?.platform || ref.platform,
        caption: (sp?.caption || own[0]?.caption || '').slice(0, 200) || null,
        thumbnail: sp?.mediaUrl || own[0]?.mediaUrl || null,
        permalink: sp?.permalink || own[0]?.permalink || null,
        items: own
          .filter((l) => l.offering?.isActive)
          .map((l) => ({ id: l.offering.id, title: l.offering.title, price: priceLabel(l.offering) })),
      });
    }
    return out;
  }

  /** Turns automatic replies on or off for one chat. */
  async setAi(orgId: string, conversationId: string, enabled: boolean) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, orgId },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    const goalState = {
      ...((conversation.goalState as Record<string, unknown>) || {}),
    };
    // Resuming clears every reason the AI was quiet, a crisis included.
    for (const key of [
      'handedOffUntil',
      'sellerPausedUntil',
      'handoffReason',
      'crisisAt',
      'aiDownNoticeAt',
    ])
      delete goalState[key];
    const updated = await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        aiEnabled: enabled,
        goalState: goalState as Prisma.InputJsonValue,
      },
    });
    // Other open dashboards of this org should see the toggle too.
    this.realtime.inboxChanged(orgId, {
      kind: 'conversation',
      conversationId: updated.id,
    });
    return { id: updated.id, aiPaused: aiPaused(updated) };
  }

  async listMessages(
    orgId: string,
    platform: string,
    conversationOrPeerId: string,
  ) {
    let conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationOrPeerId, orgId },
    });
    if (!conversation) {
      conversation = await this.prisma.conversation.findFirst({
        where: {
          orgId,
          channel: { platform: platform.toUpperCase() },
          contact: { platformUserId: conversationOrPeerId },
        },
      });
    }
    if (!conversation) return [];
    const messages = await this.prisma.inboxMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return messages.map((m) => ({
      // A public comment (or our public reply to one), else a DM.
      kind: m.type === 'COMMENT' || (m.payload as { kind?: string } | null)?.kind === 'comment' ? 'comment' : 'dm',
      postId: ((m.payload as { postId?: string } | null)?.postId as string | undefined) || null,
      from:
        m.direction === 'INBOUND'
          ? 'customer'
          : m.sentBy === 'SYSTEM'
            ? 'system'
            : m.sentBy === 'AI'
              ? 'ai'
              : 'agent',
      text: m.body || '',
      time: m.createdAt.toISOString(),
    }));
  }

  async reply(
    user: JwtPayload,
    platform: string,
    conversationOrPeerId: string,
    text: string,
  ) {
    if (!text?.trim()) throw new BadRequestException('Message is empty');
    const plat = platform.toUpperCase();

    let conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationOrPeerId, orgId: user.orgId },
      include: { contact: true, channel: true },
    });
    if (!conversation) {
      conversation = await this.prisma.conversation.findFirst({
        where: {
          orgId: user.orgId,
          channel: { platform: plat },
          contact: { platformUserId: conversationOrPeerId },
        },
        include: { contact: true, channel: true },
        orderBy: { lastInboundAt: 'desc' },
      });
    }
    if (!conversation) throw new NotFoundException('Conversation not found');

    // Reply through the Page / number the customer wrote to, not whichever
    // channel of that platform happens to come first.
    const channel = conversation.channel;
    if (!channel.isActive || channel.status === 'DISCONNECTED') {
      throw new BadRequestException(
        `${channel.name} is disconnected. Reconnect it in Channels to reply.`,
      );
    }

    if (
      conversation.windowExpiresAt &&
      conversation.windowExpiresAt < new Date() &&
      channel.platform === 'WHATSAPP'
    ) {
      throw new BadRequestException(
        '24h customer service window closed — send an approved template',
      );
    }

    const token = this.crypto.decrypt(channel.accessTokenEncrypted);
    const peerId = conversation.contact.platformUserId;
    const failure: { message?: string } = {};
    let sent: boolean;
    if (channel.platform === 'WHATSAPP') {
      sent = await this.metaPublisher.sendWhatsAppMessage(
        channel.channelIdentifier,
        peerId,
        text,
        token,
        undefined,
        failure,
      );
    } else if (channel.platform === 'FACEBOOK') {
      sent = await this.metaPublisher.sendFacebookMessengerDm(
        channel.channelIdentifier,
        peerId,
        text,
        token,
        failure,
      );
    } else {
      sent = await this.metaPublisher.sendPrivateDm(
        peerId,
        text,
        token,
        failure,
      );
    }
    // Only record what Meta accepted, so the inbox never shows a reply the
    // customer did not get.
    if (!sent) {
      throw new BadGatewayException(
        `Meta did not deliver the reply: ${failure.message || 'unknown error'}`,
      );
    }
    await this.conversations.ingestOutbound(
      user.orgId,
      conversation.id,
      text,
      'HUMAN',
    );
    // The seller is talking to this customer now: the AI steps back for a
    // while so the two do not answer over each other. A soft "team will
    // confirm" flag is settled by the seller's own answer.
    const goalState: Record<string, unknown> = {
      ...((conversation.goalState as Record<string, unknown>) || {}),
      sellerPausedUntil: new Date(Date.now() + SELLER_REPLY_PAUSE_MS).toISOString(),
    };
    if (goalState.handoffReason && goalState.handoffReason !== 'crisis')
      delete goalState.handoffReason;
    await this.prisma.conversation
      .update({
        where: { id: conversation.id },
        data: { goalState: goalState as Prisma.InputJsonValue },
      })
      .catch(() => undefined);
    this.realtime.inboxChanged(user.orgId, {
      kind: 'conversation',
      conversationId: conversation.id,
    });
    return { ok: true };
  }
}

function aiPaused(c: { aiEnabled: boolean; goalState: unknown }): boolean {
  return chatPaused(c);
}

/** Why the AI is quiet in this chat, for the inbox badge; null when it is not. */
export function pauseReason(
  c: { aiEnabled: boolean; goalState: unknown },
  now = new Date(),
): 'crisis' | 'handoff' | 'seller_replied' | 'off' | null {
  if (!chatPaused(c, now)) return null;
  const s = (c.goalState as GoalState | null) || {};
  const future = (iso?: string) => Boolean(iso && new Date(iso) > now);
  if (s.crisisAt || s.handoffReason === 'crisis') return 'crisis';
  if (future(s.handedOffUntil)) return 'handoff';
  if (future(s.sellerPausedUntil)) return 'seller_replied';
  return 'off';
}
