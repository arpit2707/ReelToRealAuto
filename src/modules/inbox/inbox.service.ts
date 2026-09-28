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
import { chatPaused } from '../catalog/reply-engine.service';

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
    return rows.map((c) => ({
      id: c.id,
      senderId: c.contact.platformUserId,
      name: c.contact.name || c.contact.platformUserId,
      preview: c.messages[0]?.body || '',
      platform: c.channel.platform,
      status: c.status,
      lastAt: (c.lastInboundAt || c.updatedAt).toISOString(),
      windowExpiresAt: c.windowExpiresAt,
      aiPaused: aiPaused(c),
    }));
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
