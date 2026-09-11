import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { MetaPublisherService } from '../meta-publisher/meta-publisher.service';
import { ConversationService } from '../conversations/conversation.service';
import type { JwtPayload } from '../auth/jwt';

@Injectable()
export class InboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly metaPublisher: MetaPublisherService,
    private readonly conversations: ConversationService,
  ) {}

  async listChannels(orgId: string) {
    return this.prisma.channel.findMany({
      where: { orgId, isActive: true, status: { not: 'DISCONNECTED' } },
      orderBy: { platform: 'asc' },
      select: { id: true, platform: true, name: true, channelIdentifier: true, status: true, handle: true },
    });
  }

  async listThreads(orgId: string, platform: string) {
    const rows = await this.prisma.conversation.findMany({
      where: { orgId, channel: { platform: platform.toUpperCase() } },
      include: { contact: true, channel: true, messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: { lastInboundAt: 'desc' },
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
    }));
  }

  async listMessages(orgId: string, platform: string, conversationOrPeerId: string) {
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
      from: m.direction === 'INBOUND' ? 'customer' : m.sentBy === 'SYSTEM' ? 'system' : 'agent',
      text: m.body || '',
      time: m.createdAt.toISOString(),
    }));
  }

  async reply(user: JwtPayload, platform: string, conversationOrPeerId: string, text: string) {
    const channel = await this.prisma.channel.findFirst({
      where: { orgId: user.orgId, platform: platform.toUpperCase(), isActive: true },
    });
    if (!channel) throw new NotFoundException(`No ${platform} channel connected`);

    let conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationOrPeerId, orgId: user.orgId },
      include: { contact: true },
    });
    if (!conversation) {
      conversation = await this.prisma.conversation.findFirst({
        where: {
          orgId: user.orgId,
          channelId: channel.id,
          contact: { platformUserId: conversationOrPeerId },
        },
        include: { contact: true },
      });
    }
    if (!conversation) throw new NotFoundException('Conversation not found');

    if (conversation.windowExpiresAt && conversation.windowExpiresAt < new Date() && platform.toUpperCase() === 'WHATSAPP') {
      throw new BadRequestException('24h customer service window closed — send an approved template');
    }

    const token = this.crypto.decrypt(channel.accessTokenEncrypted);
    const peerId = conversation.contact.platformUserId;
    const plat = platform.toUpperCase();
    if (plat === 'WHATSAPP') {
      await this.metaPublisher.sendWhatsAppMessage(channel.channelIdentifier, peerId, text, token);
    } else if (plat === 'FACEBOOK') {
      await this.metaPublisher.sendFacebookMessengerDm(channel.channelIdentifier, peerId, text, token);
    } else {
      await this.metaPublisher.sendPrivateDm(peerId, text, token);
    }
    await this.conversations.ingestOutbound(user.orgId, conversation.id, text, 'HUMAN');
    return { ok: true };
  }
}
