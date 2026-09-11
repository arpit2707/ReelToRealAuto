import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ConversationService {
  constructor(private readonly prisma: PrismaService) {}

  async ingestInbound(input: {
    orgId: string;
    channelId: string;
    platform: string;
    peerId: string;
    name?: string;
    text: string;
    platformMessageId?: string;
  }) {
    const contact = await this.prisma.inboxContact.upsert({
      where: {
        orgId_platform_platformUserId: {
          orgId: input.orgId,
          platform: input.platform,
          platformUserId: input.peerId,
        },
      },
      update: { name: input.name || undefined },
      create: {
        orgId: input.orgId,
        platform: input.platform,
        platformUserId: input.peerId,
        name: input.name,
      },
    });

    const windowExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const conversation = await this.prisma.conversation.upsert({
      where: { channelId_contactId: { channelId: input.channelId, contactId: contact.id } },
      update: {
        lastInboundAt: new Date(),
        windowExpiresAt,
        status: 'OPEN',
        unreadCount: { increment: 1 },
      },
      create: {
        orgId: input.orgId,
        channelId: input.channelId,
        contactId: contact.id,
        lastInboundAt: new Date(),
        windowExpiresAt,
        status: 'OPEN',
        unreadCount: 1,
      },
    });

    if (input.platformMessageId) {
      const dupe = await this.prisma.inboxMessage.findUnique({
        where: { orgId_platformMessageId: { orgId: input.orgId, platformMessageId: input.platformMessageId } },
      });
      if (dupe) return conversation;
    }

    await this.prisma.inboxMessage.create({
      data: {
        orgId: input.orgId,
        conversationId: conversation.id,
        platformMessageId: input.platformMessageId,
        direction: 'INBOUND',
        body: input.text,
        sentBy: 'HUMAN',
        status: 'DELIVERED',
      },
    });

    await this.prisma.channel.update({
      where: { id: input.channelId },
      data: { lastInboundAt: new Date() },
    }).catch(() => undefined);

    return conversation;
  }

  async ingestOutbound(orgId: string, conversationId: string, text: string, sentBy: string) {
    await this.prisma.inboxMessage.create({
      data: {
        orgId,
        conversationId,
        direction: 'OUTBOUND',
        body: text,
        sentBy,
        status: 'SENT',
      },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastOutboundAt: new Date() },
    });
  }
}
