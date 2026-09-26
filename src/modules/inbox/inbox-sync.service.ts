import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { graphUrl } from '../../common/graph';

const CONVERSATION_LIMIT = 25;
const MESSAGE_LIMIT = 25;
const WINDOW_MS = 24 * 60 * 60 * 1000;

type SyncResult = {
  channelId: string;
  name: string;
  conversations: number;
  messages: number;
  error?: string;
};

// Webhooks only deliver messages sent after a channel was connected, so an
// inbox fed by webhooks alone starts empty. This pulls the Page's existing
// Messenger / Instagram conversations from the Conversations API.
@Injectable()
export class InboxSyncService {
  private readonly logger = new Logger(InboxSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async syncOrg(orgId: string, platform?: string): Promise<SyncResult[]> {
    const plat = platform?.toUpperCase();
    const channels = await this.prisma.channel.findMany({
      where: {
        orgId,
        isActive: true,
        status: { not: 'DISCONNECTED' },
        platform: plat ? plat : { in: ['FACEBOOK', 'INSTAGRAM'] },
      },
    });
    const results: SyncResult[] = [];
    for (const channel of channels) {
      if (channel.platform !== 'FACEBOOK' && channel.platform !== 'INSTAGRAM')
        continue;
      try {
        results.push(await this.syncChannel(channel));
      } catch (err: any) {
        this.logger.warn(
          `Inbox sync failed for ${channel.platform} ${channel.channelIdentifier}: ${err.message}`,
        );
        results.push({
          channelId: channel.id,
          name: channel.name,
          conversations: 0,
          messages: 0,
          error: err.message,
        });
      }
    }
    return results;
  }

  private async graphGet(
    path: string,
    params: Record<string, string>,
    token: string,
  ) {
    const url = new URL(graphUrl(path));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      throw new Error(
        json?.error?.error_user_msg ||
          json?.error?.message ||
          `Graph API error ${res.status}`,
      );
    }
    return json;
  }

  private async syncChannel(channel: {
    id: string;
    orgId: string;
    name: string;
    platform: string;
    channelIdentifier: string;
    accessTokenEncrypted: string;
    metadata: any;
  }): Promise<SyncResult> {
    const token = this.crypto.decrypt(channel.accessTokenEncrypted);
    if (!token || token === 'REVOKED')
      throw new Error('Reconnect this channel');

    // Both platforms are read through the Page: Instagram DMs of a Page-linked
    // account live on /{page-id}/conversations?platform=instagram.
    const isIg = channel.platform === 'INSTAGRAM';
    const pageId = isIg ? channel.metadata?.pageId : channel.channelIdentifier;
    if (!pageId)
      throw new Error(
        'Linked Facebook Page unknown; reconnect this Instagram account',
      );
    const selfIds = new Set([channel.channelIdentifier, pageId]);

    const params: Record<string, string> = {
      fields: `id,updated_time,participants,messages.limit(${MESSAGE_LIMIT}){id,message,from,created_time}`,
      limit: String(CONVERSATION_LIMIT),
    };
    if (isIg) params.platform = 'instagram';
    const json = await this.graphGet(`/${pageId}/conversations`, params, token);

    let conversations = 0;
    let messages = 0;
    for (const conv of json.data || []) {
      const participants: any[] = conv.participants?.data || [];
      const peer = participants.find(
        (p) => p?.id && !selfIds.has(String(p.id)),
      );
      if (!peer) continue;
      const peerId = String(peer.id);
      const peerName: string | undefined =
        peer.name || peer.username || undefined;
      const rows: any[] = (conv.messages?.data || []).filter((m: any) => m?.id);
      if (rows.length === 0) continue;

      const contact = await this.prisma.inboxContact.upsert({
        where: {
          orgId_platform_platformUserId: {
            orgId: channel.orgId,
            platform: channel.platform,
            platformUserId: peerId,
          },
        },
        update: peerName ? { name: peerName } : {},
        create: {
          orgId: channel.orgId,
          platform: channel.platform,
          platformUserId: peerId,
          name: peerName,
        },
      });

      const inboundTimes = rows
        .filter((m) => String(m.from?.id) === peerId)
        .map((m) => new Date(m.created_time).getTime())
        .filter((t) => !Number.isNaN(t));
      const outboundTimes = rows
        .filter((m) => String(m.from?.id) !== peerId)
        .map((m) => new Date(m.created_time).getTime())
        .filter((t) => !Number.isNaN(t));
      const lastInbound = inboundTimes.length
        ? new Date(Math.max(...inboundTimes))
        : null;
      const lastOutbound = outboundTimes.length
        ? new Date(Math.max(...outboundTimes))
        : null;

      const existing = await this.prisma.conversation.findUnique({
        where: {
          channelId_contactId: { channelId: channel.id, contactId: contact.id },
        },
      });
      // Never move timestamps backwards past what live webhooks recorded.
      const later = (a: Date | null | undefined, b: Date | null) =>
        a && b ? (a > b ? a : b) : a || b;
      const newestInbound = later(existing?.lastInboundAt, lastInbound);
      const conversation = existing
        ? await this.prisma.conversation.update({
            where: { id: existing.id },
            data: {
              lastInboundAt: newestInbound,
              lastOutboundAt: later(existing.lastOutboundAt, lastOutbound),
              windowExpiresAt: newestInbound
                ? new Date(newestInbound.getTime() + WINDOW_MS)
                : existing.windowExpiresAt,
            },
          })
        : await this.prisma.conversation.create({
            data: {
              orgId: channel.orgId,
              channelId: channel.id,
              contactId: contact.id,
              lastInboundAt: lastInbound,
              lastOutboundAt: lastOutbound,
              windowExpiresAt: lastInbound
                ? new Date(lastInbound.getTime() + WINDOW_MS)
                : null,
              status: 'OPEN',
            },
          });
      conversations += 1;

      const ids = rows.map((m) => String(m.id));
      const known = new Set(
        (
          await this.prisma.inboxMessage.findMany({
            where: { orgId: channel.orgId, platformMessageId: { in: ids } },
            select: { platformMessageId: true },
          })
        ).map((m) => m.platformMessageId),
      );
      const fresh = rows.filter((m) => !known.has(String(m.id)));
      if (fresh.length) {
        const created = await this.prisma.inboxMessage.createMany({
          data: fresh.map((m) => {
            const inbound = String(m.from?.id) === peerId;
            const at = new Date(m.created_time);
            return {
              orgId: channel.orgId,
              conversationId: conversation.id,
              platformMessageId: String(m.id),
              direction: inbound ? 'INBOUND' : 'OUTBOUND',
              body: m.message || '(attachment)',
              sentBy: inbound ? 'HUMAN' : 'PAGE',
              status: inbound ? 'DELIVERED' : 'SENT',
              createdAt: Number.isNaN(at.getTime()) ? new Date() : at,
            };
          }),
          skipDuplicates: true,
        });
        messages += created.count;
      }
    }

    await this.prisma.channel
      .update({
        where: { id: channel.id },
        data: { lastHealthCheckAt: new Date() },
      })
      .catch(() => undefined);
    return {
      channelId: channel.id,
      name: channel.name,
      conversations,
      messages,
    };
  }
}
