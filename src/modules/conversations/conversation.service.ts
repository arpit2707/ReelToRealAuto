import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

@Injectable()
export class ConversationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async ingestInbound(input: {
    orgId: string;
    channelId: string;
    platform: string;
    peerId: string;
    name?: string;
    text: string;
    platformMessageId?: string;
    // IMAGE, SHARE, ... for a message without text.
    type?: string;
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
        ...(input.type ? { type: input.type } : {}),
        body: input.text,
        sentBy: 'HUMAN',
        status: 'DELIVERED',
      },
    });

    await this.prisma.channel.update({
      where: { id: input.channelId },
      data: { lastInboundAt: new Date() },
    }).catch(() => undefined);

    this.realtime.inboxChanged(input.orgId, {
      kind: 'message',
      conversationId: conversation.id,
      platform: input.platform,
    });
    return conversation;
  }

  /**
   * A comment on a post, saved in the commenter's chat as "Commented on post".
   * Unlike a DM it does not open WhatsApp-style reply windows or count as
   * unread: the customer did not write to us privately.
   */
  async attachComment(input: {
    orgId: string;
    channelId: string;
    platform: string;
    authorId: string;
    authorName?: string | null;
    text: string;
    commentId: string;
    postId: string | null;
    parentId?: string | null;
  }) {
    const contact = await this.prisma.inboxContact.upsert({
      where: {
        orgId_platform_platformUserId: {
          orgId: input.orgId,
          platform: input.platform,
          platformUserId: input.authorId,
        },
      },
      update: {
        ...(input.platform === 'INSTAGRAM' && input.authorName ? { username: input.authorName } : {}),
      },
      create: {
        orgId: input.orgId,
        platform: input.platform,
        platformUserId: input.authorId,
        name: input.authorName || null,
        username: input.platform === 'INSTAGRAM' ? input.authorName || null : null,
      },
    });
    const conversation = await this.prisma.conversation.upsert({
      where: { channelId_contactId: { channelId: input.channelId, contactId: contact.id } },
      update: {},
      create: {
        orgId: input.orgId,
        channelId: input.channelId,
        contactId: contact.id,
        status: 'OPEN',
        sourcePostId: input.postId,
        sourcePlatform: input.platform,
        sourceKind: 'comment',
      },
    });
    const dupe = await this.prisma.inboxMessage.findUnique({
      where: { orgId_platformMessageId: { orgId: input.orgId, platformMessageId: input.commentId } },
    });
    if (!dupe) {
      await this.prisma.inboxMessage.create({
        data: {
          orgId: input.orgId,
          conversationId: conversation.id,
          platformMessageId: input.commentId,
          direction: 'INBOUND',
          type: 'COMMENT',
          body: input.text,
          payload: {
            kind: 'comment',
            postId: input.postId,
            commentId: input.commentId,
            parentId: input.parentId || null,
          },
          sentBy: 'HUMAN',
          status: 'DELIVERED',
        },
      });
      this.realtime.inboxChanged(input.orgId, {
        kind: 'message',
        conversationId: conversation.id,
        platform: input.platform,
      });
    }
    return conversation;
  }

  /**
   * After a Private Reply, Meta returns the commenter's messaging id. The DM
   * chat with that id starts from the post, so a later "isme bridal entry
   * included hai?" is answered about the post's item.
   */
  async linkPrivateReply(input: {
    orgId: string;
    channelId: string;
    platform: string;
    recipientId: string;
    name?: string | null;
    postId: string;
  }) {
    const contact = await this.prisma.inboxContact.upsert({
      where: {
        orgId_platform_platformUserId: {
          orgId: input.orgId,
          platform: input.platform,
          platformUserId: input.recipientId,
        },
      },
      update: {},
      create: {
        orgId: input.orgId,
        platform: input.platform,
        platformUserId: input.recipientId,
        name: input.name || null,
        username: input.platform === 'INSTAGRAM' ? input.name || null : null,
      },
    });
    const existing = await this.prisma.conversation.findUnique({
      where: { channelId_contactId: { channelId: input.channelId, contactId: contact.id } },
      select: { id: true, goalState: true, sourcePostId: true },
    });
    const goalState = {
      ...((existing?.goalState as Record<string, unknown>) || {}),
      postId: input.postId,
      postAt: new Date().toISOString(),
    };
    if (existing) {
      return this.prisma.conversation.update({
        where: { id: existing.id },
        data: {
          goalState: goalState as Prisma.InputJsonValue,
          ...(existing.sourcePostId
            ? {}
            : { sourcePostId: input.postId, sourcePlatform: input.platform, sourceKind: 'comment' }),
        },
      });
    }
    return this.prisma.conversation.create({
      data: {
        orgId: input.orgId,
        channelId: input.channelId,
        contactId: contact.id,
        status: 'OPEN',
        sourcePostId: input.postId,
        sourcePlatform: input.platform,
        sourceKind: 'comment',
        goalState: goalState as Prisma.InputJsonValue,
      },
    });
  }

  /** Records the post a chat started from, the first time one is known. */
  async markSource(conversationId: string, postId: string, platform: string, kind: string) {
    await this.prisma.conversation.updateMany({
      where: { id: conversationId, sourcePostId: null },
      data: { sourcePostId: postId, sourcePlatform: platform, sourceKind: kind },
    });
  }

  async ingestOutbound(
    orgId: string,
    conversationId: string,
    text: string,
    sentBy: string,
    // { kind: 'comment', commentId } for a public reply under a comment.
    payload?: Record<string, unknown>,
  ) {
    await this.prisma.inboxMessage.create({
      data: {
        orgId,
        conversationId,
        direction: 'OUTBOUND',
        type: payload?.kind === 'comment' ? 'COMMENT' : 'TEXT',
        body: text,
        ...(payload ? { payload: payload as Prisma.InputJsonValue } : {}),
        sentBy,
        status: 'SENT',
      },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastOutboundAt: new Date() },
    });
    this.realtime.inboxChanged(orgId, { kind: 'message', conversationId });
  }
}
