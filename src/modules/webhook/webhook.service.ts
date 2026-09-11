import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { AiClientService } from '../ai-client/ai-client.service';
import { MetaPublisherService } from '../meta-publisher/meta-publisher.service';
import { ShopifyService } from '../shopify/shopify.service';
import { ConversationService } from '../conversations/conversation.service';
import { hmacSha256Hex, timingSafeEqualString } from '../../common/hmac';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly aiClient: AiClientService,
    private readonly metaPublisher: MetaPublisherService,
    private readonly shopifyService: ShopifyService,
    private readonly conversations: ConversationService,
  ) {}

  verifyWebhook(mode: string, token: string, challenge: string): string | null {
    const verifyToken = process.env.META_VERIFY_TOKEN || '';
    if (!verifyToken) {
      this.logger.error('META_VERIFY_TOKEN is not set; rejecting webhook handshake');
      return null;
    }
    if (mode === 'subscribe' && token === verifyToken) {
      this.logger.log('Meta Webhook verification handshake successful!');
      return challenge;
    }
    this.logger.warn(`Verification failed: mode=${mode}`);
    return null;
  }

  verifySignature(signatureHeader: string | undefined, rawPayload: Buffer | undefined): boolean {
    const appSecret = process.env.META_APP_SECRET || '';
    if (!appSecret) {
      this.logger.error('META_APP_SECRET is not set; rejecting webhook');
      return false;
    }
    if (!rawPayload || rawPayload.length === 0) {
      return false;
    }
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
      return false;
    }
    const signature = signatureHeader.substring(7);
    const expected = hmacSha256Hex(appSecret, rawPayload);
    return timingSafeEqualString(signature, expected);
  }

  async processWebhookEvent(payload: any, signatureOk = true) {
    await this.prisma.webhookEvent
      .create({
        data: {
          object: String(payload?.object || 'unknown'),
          payload,
          signatureOk,
        },
      })
      .catch((e) => this.logger.error(`Failed to persist webhook event: ${e.message}`));

    this.logger.log(`Inbound webhook received: object=${payload.object}`);

    if (!payload.entry || !Array.isArray(payload.entry)) return;

    if (payload.object === 'whatsapp_business_account') {
      for (const entry of payload.entry) {
        await this.processWhatsAppEntry(entry);
      }
      return;
    }
    if (payload.object === 'page') {
      for (const entry of payload.entry) {
        await this.processFacebookPageEntry(entry);
      }
      return;
    }
    if (payload.object === 'instagram') {
      for (const entry of payload.entry) {
        await this.processInstagramEntry(entry);
      }
      return;
    }

    this.logger.warn(`Ignoring unknown webhook object type: ${payload.object}`);
  }

  private async claimEvent(eventId: string | undefined, source: string): Promise<boolean> {
    if (!eventId) return true;
    try {
      await this.prisma.processedWebhookEvent.create({
        data: { eventId, source },
      });
      return true;
    } catch {
      this.logger.log(`Skipping duplicate webhook event ${eventId} (${source})`);
      return false;
    }
  }

  private decryptChannelToken(encrypted?: string | null): string | null {
    if (!encrypted) return null;
    try {
      return this.crypto.decrypt(encrypted);
    } catch (e: any) {
      this.logger.error(`Failed to decrypt channel token: ${e.message}`);
      return null;
    }
  }

  private async processWhatsAppEntry(entry: any) {
    const wabaId = entry.id;
    if (!entry.changes || !Array.isArray(entry.changes)) return;

    for (const change of entry.changes) {
      if (change.field === 'account_alerts' || change.field === 'account_update') {
        this.logger.warn(
          `WhatsApp ${change.field} for WABA ${wabaId}: ${JSON.stringify(change.value || {})}`,
        );
        continue;
      }

      if (change.field === 'messages' && change.value) {
        const metadata = change.value.metadata;
        const phoneNumberId = metadata?.phone_number_id || wabaId;
        const displayPhone = metadata?.display_phone_number || '';

        const statuses = change.value.statuses || [];
        if (statuses.length > 0) {
          await this.persistWhatsAppStatuses(phoneNumberId, statuses);
        }

        const messages = change.value.messages || [];
        if (messages.length === 0) continue;

        this.logger.log(`Processing WhatsApp event for Phone ID: ${phoneNumberId} (${displayPhone})`);

        const channel = await this.prisma.channel.findFirst({
          where: {
            channelIdentifier: phoneNumberId,
            platform: 'WHATSAPP',
            isActive: true,
          },
          include: { org: true },
        });

        if (!channel) {
          this.logger.warn(`No active WhatsApp channel for phone number id ${phoneNumberId}; skipping send`);
          continue;
        }

        const decryptedToken = this.decryptChannelToken(channel.accessTokenEncrypted);
        if (!decryptedToken) {
          this.logger.warn(`WhatsApp channel ${phoneNumberId} has no usable access token; skipping send`);
          continue;
        }

        const brandId = channel.orgId;
        const brandName = channel.org?.name || 'WhatsApp Business';

        for (const msg of messages) {
          if (!(await this.claimEvent(msg.id, 'whatsapp_message'))) continue;

          const fromWaId = msg.from;
          const buttonId = msg.interactive?.button_reply?.id;
          const text =
            msg.text?.body || msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title;
          if (!text || !fromWaId) continue;

          await this.conversations.ingestInbound({
            orgId: channel.orgId,
            channelId: channel.id,
            platform: 'WHATSAPP',
            peerId: fromWaId,
            text,
            platformMessageId: msg.id,
          });

          if (buttonId && (buttonId.startsWith('COD_CONFIRM_') || buttonId.startsWith('COD_CANCEL_'))) {
            await this.shopifyService.handleCodButtonCallback(buttonId, fromWaId, phoneNumberId, decryptedToken);
            continue;
          }

          this.logger.log(`WhatsApp message from ${fromWaId}: "${text}" [Brand: ${brandName}]`);

          const aiResponse = await this.aiClient.generateReply({
            brand_id: brandId,
            channel_type: 'whatsapp',
            event_type: 'dm',
            message_text: text,
            sender_id: fromWaId,
            brand_persona: {
              brand_name: brandName,
            },
          });

          const replyMessage = aiResponse.private_dm || aiResponse.public_reply || 'Thanks for contacting us!';

          await this.metaPublisher.sendWhatsAppMessage(
            phoneNumberId,
            fromWaId,
            replyMessage,
            decryptedToken,
            undefined,
          );

          await this.prisma.interactionLog
            .create({
              data: {
                orgId: channel.orgId,
                channelType: 'WHATSAPP',
                eventType: 'DM',
                inboundMessage: text,
                senderId: fromWaId,
                privateDm: replyMessage,
                intent: aiResponse.intent,
                sentiment: aiResponse.sentiment,
                requiresHuman: aiResponse.requires_human_attention,
                externalEventId: msg.id || undefined,
              },
            })
            .catch((e) => this.logger.error(`Failed to log WhatsApp interaction: ${e.message}`));
        }
      }
    }
  }

  private async persistWhatsAppStatuses(phoneNumberId: string, statuses: any[]) {
    const channel = await this.prisma.channel.findFirst({
      where: { channelIdentifier: phoneNumberId, platform: 'WHATSAPP', isActive: true },
    });

    for (const status of statuses) {
      const error = status.errors?.[0];
      const ts = status.timestamp ? new Date(Number(status.timestamp) * 1000) : undefined;
      await this.prisma.whatsAppMessageStatus
        .create({
          data: {
            orgId: channel?.orgId,
            phoneNumberId,
            messageId: String(status.id || ''),
            recipientWaId: status.recipient_id || null,
            status: String(status.status || 'unknown'),
            timestamp: ts && !Number.isNaN(ts.getTime()) ? ts : null,
            errorCode: error?.code != null ? String(error.code) : null,
            errorTitle: error?.title || error?.message || null,
            rawPayload: status,
          },
        })
        .catch((e) => this.logger.error(`Failed to persist WhatsApp status: ${e.message}`));

      if (status.status === 'failed') {
        this.logger.warn(
          `WhatsApp delivery failed messageId=${status.id} recipient=${status.recipient_id} code=${error?.code} title=${error?.title}`,
        );
      }
    }
  }

  private async processFacebookPageEntry(entry: any) {
    const pageId = entry.id;
    this.logger.log(`Processing Facebook Page event for Page ID: ${pageId}`);

    const channel = await this.prisma.channel.findFirst({
      where: {
        channelIdentifier: pageId,
        platform: 'FACEBOOK',
        isActive: true,
      },
      include: { org: true },
    });

    if (!channel) {
      this.logger.warn(`No active Facebook channel for page ${pageId}; skipping send`);
      return;
    }

    const decryptedToken = this.decryptChannelToken(channel.accessTokenEncrypted);
    if (!decryptedToken) {
      this.logger.warn(`Facebook channel ${pageId} has no usable access token; skipping send`);
      return;
    }

    const brandId = channel.orgId;
    const brandName = channel.org?.name || 'Facebook Page';

    if (entry.changes) {
      for (const change of entry.changes) {
        if (change.field === 'feed' && change.value?.item === 'comment') {
          const commentVal = change.value;
          const commentId = commentVal.comment_id;
          const text = commentVal.message;
          const senderId = commentVal.from?.id;

          if (senderId && senderId === pageId) {
            this.logger.log(`Skipping self-comment on Page ${pageId}`);
            continue;
          }
          if (!(await this.claimEvent(commentId, 'facebook_comment'))) continue;
          if (!text || !commentId) continue;

          const aiResponse = await this.aiClient.generateReply({
            brand_id: brandId,
            channel_type: 'facebook',
            event_type: 'comment',
            message_text: text,
            sender_id: senderId || 'anonymous',
            brand_persona: { brand_name: brandName },
          });

          if (aiResponse.public_reply) {
            await this.metaPublisher.replyToFacebookComment(commentId, aiResponse.public_reply, decryptedToken);
          }
          if (aiResponse.private_dm && senderId) {
            await this.metaPublisher.sendFacebookMessengerDm(pageId, senderId, aiResponse.private_dm, decryptedToken);
          }

          await this.prisma.interactionLog
            .create({
              data: {
                orgId: channel.orgId,
                channelType: 'FACEBOOK',
                eventType: 'COMMENT',
                inboundMessage: text,
                senderId: senderId || 'anonymous',
                publicReply: aiResponse.public_reply,
                privateDm: aiResponse.private_dm,
                intent: aiResponse.intent,
                sentiment: aiResponse.sentiment,
                requiresHuman: aiResponse.requires_human_attention,
                externalEventId: commentId,
              },
            })
            .catch((e) => this.logger.error(`Failed to log Facebook comment: ${e.message}`));
        }
      }
    }

    if (entry.messaging) {
      for (const msg of entry.messaging) {
        if (msg.message?.is_echo) {
          this.logger.log('Skipping Facebook Messenger echo');
          continue;
        }
        const senderId = msg.sender?.id;
        if (senderId && senderId === pageId) continue;

        const mid = msg.message?.mid;
        if (!(await this.claimEvent(mid, 'facebook_dm'))) continue;

        const text = msg.message?.text;
        if (!text || !senderId) continue;

        await this.conversations.ingestInbound({
          orgId: channel.orgId,
          channelId: channel.id,
          platform: 'FACEBOOK',
          peerId: senderId,
          text,
          platformMessageId: mid,
        });

        const aiResponse = await this.aiClient.generateReply({
          brand_id: brandId,
          channel_type: 'facebook',
          event_type: 'dm',
          message_text: text,
          sender_id: senderId,
          brand_persona: { brand_name: brandName },
        });

        if (aiResponse.private_dm) {
          await this.metaPublisher.sendFacebookMessengerDm(pageId, senderId, aiResponse.private_dm, decryptedToken);
        }

        await this.prisma.interactionLog
          .create({
            data: {
              orgId: channel.orgId,
              channelType: 'FACEBOOK',
              eventType: 'DM',
              inboundMessage: text,
              senderId,
              privateDm: aiResponse.private_dm,
              intent: aiResponse.intent,
              sentiment: aiResponse.sentiment,
              requiresHuman: aiResponse.requires_human_attention,
              externalEventId: mid,
            },
          })
          .catch((e) => this.logger.error(`Failed to log Facebook DM: ${e.message}`));
      }
    }
  }

  private async processInstagramEntry(entry: any) {
    const entryId = entry.id;
    this.logger.log(`Processing Instagram event for Account ID: ${entryId}`);

    const channel = await this.prisma.channel.findFirst({
      where: {
        channelIdentifier: entryId,
        platform: 'INSTAGRAM',
        isActive: true,
      },
      include: { org: true },
    });

    if (!channel) {
      this.logger.warn(`No active Instagram channel for ${entryId}; skipping send`);
      return;
    }

    const decryptedToken = this.decryptChannelToken(channel.accessTokenEncrypted);
    if (!decryptedToken) {
      this.logger.warn(`Instagram channel ${entryId} has no usable access token; skipping send`);
      return;
    }

    const brandId = channel.orgId;
    const brandName = channel.org?.name || 'Instagram Account';

    if (entry.changes) {
      for (const change of entry.changes) {
        if (change.field === 'comments') {
          await this.handleComment(
            change.value,
            brandId,
            brandName,
            decryptedToken,
            channel.orgId,
            entryId,
          );
        }
      }
    }

    if (entry.messaging) {
      for (const msg of entry.messaging) {
        await this.handleMessage(msg, brandId, brandName, decryptedToken, channel.orgId, entryId, channel.id);
      }
    }
  }

  private async handleComment(
    commentData: any,
    brandId: string,
    brandName: string,
    accessToken: string,
    orgId: string,
    igAccountId: string,
  ) {
    const commentId = commentData.id;
    const text = commentData.text;
    const senderId = commentData.from?.id;
    const mediaId = commentData.media?.id;

    if (senderId && senderId === igAccountId) {
      this.logger.log(`Skipping self-comment on IG ${igAccountId}`);
      return;
    }
    if (!(await this.claimEvent(commentId, 'instagram_comment'))) return;
    if (!text || !commentId) return;

    this.logger.log(`Processing comment [${commentId}] on Brand: ${brandName}`);

    const aiResponse = await this.aiClient.generateReply({
      brand_id: brandId,
      channel_type: 'instagram',
      event_type: 'comment',
      message_text: text,
      sender_id: senderId || 'anonymous',
      post_context: {
        post_id: mediaId || '',
      },
      brand_persona: {
        brand_name: brandName,
      },
    });

    if (aiResponse.public_reply) {
      await this.metaPublisher.replyToComment(commentId, aiResponse.public_reply, accessToken);
    }

    if (aiResponse.private_dm && senderId) {
      await this.metaPublisher.sendPrivateDm(senderId, aiResponse.private_dm, accessToken);
    }

    await this.prisma.interactionLog
      .create({
        data: {
          orgId,
          channelType: 'INSTAGRAM',
          eventType: 'COMMENT',
          inboundMessage: text,
          senderId: senderId || 'anonymous',
          publicReply: aiResponse.public_reply,
          privateDm: aiResponse.private_dm,
          intent: aiResponse.intent,
          sentiment: aiResponse.sentiment,
          requiresHuman: aiResponse.requires_human_attention,
          externalEventId: commentId,
        },
      })
      .catch((e) => this.logger.error(`Failed to log interaction: ${e.message}`));
  }

  private async handleMessage(
    messageData: any,
    brandId: string,
    brandName: string,
    accessToken: string,
    orgId: string,
    igAccountId: string,
    channelId: string,
  ) {
    if (messageData.message?.is_echo) {
      this.logger.log('Skipping Instagram echo');
      return;
    }

    const text = messageData.message?.text;
    const senderId = messageData.sender?.id;
    if (senderId && senderId === igAccountId) return;

    const mid = messageData.message?.mid;
    if (!(await this.claimEvent(mid, 'instagram_dm'))) return;
    if (!text || !senderId) return;

    await this.conversations.ingestInbound({
      orgId,
      channelId,
      platform: 'INSTAGRAM',
      peerId: senderId,
      text,
      platformMessageId: mid,
    });

    this.logger.log(`Processing DM from [${senderId}] on Brand: ${brandName}`);

    const aiResponse = await this.aiClient.generateReply({
      brand_id: brandId,
      channel_type: 'instagram',
      event_type: 'dm',
      message_text: text,
      sender_id: senderId,
      brand_persona: {
        brand_name: brandName,
      },
    });

    if (aiResponse.private_dm) {
      await this.metaPublisher.sendPrivateDm(senderId, aiResponse.private_dm, accessToken);
    }

    await this.prisma.interactionLog
      .create({
        data: {
          orgId,
          channelType: 'INSTAGRAM',
          eventType: 'DM',
          inboundMessage: text,
          senderId,
          privateDm: aiResponse.private_dm,
          intent: aiResponse.intent,
          sentiment: aiResponse.sentiment,
          requiresHuman: aiResponse.requires_human_attention,
          externalEventId: mid,
        },
      })
      .catch((e) => this.logger.error(`Failed to log interaction: ${e.message}`));
  }

  async simulateInteraction(data: {
    message_text: string;
    channel_type?: string;
    event_type?: string;
    brand_id?: string;
    post_id?: string;
    tagged_product_sku?: string;
  }) {
    return await this.aiClient.generateReply({
      brand_id: data.brand_id || 'sim_brand',
      channel_type: data.channel_type || 'instagram',
      event_type: data.event_type || 'comment',
      message_text: data.message_text,
      sender_id: 'simulated_user_123',
      post_context: {
        post_id: data.post_id || 'post_sim_1',
        tagged_product_sku: data.tagged_product_sku,
      },
    });
  }
}
