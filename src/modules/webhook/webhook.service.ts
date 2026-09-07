import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { AiClientService } from '../ai-client/ai-client.service';
import { MetaPublisherService } from '../meta-publisher/meta-publisher.service';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private readonly appSecret = process.env.META_APP_SECRET || '';
  private readonly verifyToken = process.env.META_VERIFY_TOKEN || 'reel2real_verify_secret';

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly aiClient: AiClientService,
    private readonly metaPublisher: MetaPublisherService,
  ) {}

  verifyWebhook(mode: string, token: string, challenge: string): string | null {
    if (mode === 'subscribe' && token === this.verifyToken) {
      this.logger.log('Meta Webhook verification handshake successful!');
      return challenge;
    }
    this.logger.warn(`Verification failed: mode=${mode}, token=${token}`);
    return null;
  }

  verifySignature(signatureHeader: string | undefined, rawPayload: string): boolean {
    if (!this.appSecret) {
      return true; // Dev mode
    }
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
      return false;
    }
    const signature = signatureHeader.substring(7);
    const expected = crypto.createHmac('sha256', this.appSecret).update(rawPayload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  async processWebhookEvent(payload: any) {
    this.logger.log(`Inbound webhook received: object=${payload.object}`);

    if (!payload.entry || !Array.isArray(payload.entry)) return;

    for (const entry of payload.entry) {
      if (payload.object === 'whatsapp_business_account') {
        await this.processWhatsAppEntry(entry);
      } else if (payload.object === 'page') {
        await this.processFacebookPageEntry(entry);
      } else if (payload.object === 'instagram') {
        await this.processInstagramEntry(entry);
      } else {
        // Generic fallback by entry.id
        await this.processInstagramEntry(entry);
      }
    }
  }

  private async processWhatsAppEntry(entry: any) {
    const wabaId = entry.id;
    if (!entry.changes || !Array.isArray(entry.changes)) return;

    for (const change of entry.changes) {
      if (change.field === 'messages' && change.value) {
        const metadata = change.value.metadata;
        const phoneNumberId = metadata?.phone_number_id || wabaId;
        const displayPhone = metadata?.display_phone_number || '';

        this.logger.log(`Processing WhatsApp event for Phone ID: ${phoneNumberId} (${displayPhone})`);

        // Strict Multi-tenant lookup for WhatsApp Channel
        const channel = await this.prisma.channel.findFirst({
          where: {
            channelIdentifier: phoneNumberId,
            platform: 'WHATSAPP',
            isActive: true,
          },
          include: { org: true },
        });

        const brandId = channel ? channel.orgId : 'default_brand';
        const brandName = channel?.org?.name || 'WhatsApp Business';
        let decryptedToken = 'mock_token';

        if (channel?.accessTokenEncrypted) {
          try {
            decryptedToken = this.crypto.decrypt(channel.accessTokenEncrypted);
          } catch (e: any) {
            this.logger.error(`Failed to decrypt WhatsApp token: ${e.message}`);
          }
        }

        const messages = change.value.messages || [];
        for (const msg of messages) {
          const fromWaId = msg.from;
          const text = msg.text?.body || msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title;
          if (!text || !fromWaId) continue;

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

          if (channel?.orgId) {
            await this.prisma.interactionLog.create({
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
              },
            }).catch((e) => this.logger.error(`Failed to log WhatsApp interaction: ${e.message}`));
          }
        }
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

    const brandId = channel ? channel.orgId : 'default_brand';
    const brandName = channel?.org?.name || 'Facebook Page';
    let decryptedToken = 'mock_token';

    if (channel?.accessTokenEncrypted) {
      try {
        decryptedToken = this.crypto.decrypt(channel.accessTokenEncrypted);
      } catch (e: any) {
        this.logger.error(`Failed to decrypt Facebook token: ${e.message}`);
      }
    }

    // Facebook Feed Comments
    if (entry.changes) {
      for (const change of entry.changes) {
        if (change.field === 'feed' && change.value?.item === 'comment') {
          const commentVal = change.value;
          const commentId = commentVal.comment_id;
          const text = commentVal.message;
          const senderId = commentVal.from?.id;

          if (text && commentId) {
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

            if (channel?.orgId) {
              await this.prisma.interactionLog.create({
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
                },
              }).catch((e) => this.logger.error(`Failed to log Facebook comment: ${e.message}`));
            }
          }
        }
      }
    }

    // Facebook Messenger DMs
    if (entry.messaging) {
      for (const msg of entry.messaging) {
        const text = msg.message?.text;
        const senderId = msg.sender?.id;
        if (text && senderId) {
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

          if (channel?.orgId) {
            await this.prisma.interactionLog.create({
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
              },
            }).catch((e) => this.logger.error(`Failed to log Facebook DM: ${e.message}`));
          }
        }
      }
    }
  }

  private async processInstagramEntry(entry: any) {
    const entryId = entry.id; // Instagram Account ID
    this.logger.log(`Processing Instagram event for Account ID: ${entryId}`);

    const channel = await this.prisma.channel.findFirst({
      where: {
        channelIdentifier: entryId,
        platform: 'INSTAGRAM',
        isActive: true,
      },
      include: { org: true },
    });

    const brandId = channel ? channel.orgId : 'default_brand';
    const brandName = channel?.org?.name || 'Instagram Account';
    let decryptedToken = 'mock_token';

    if (channel?.accessTokenEncrypted) {
      try {
        decryptedToken = this.crypto.decrypt(channel.accessTokenEncrypted);
      } catch (e: any) {
        this.logger.error(`Failed to decrypt Instagram token: ${e.message}`);
      }
    }

    if (entry.changes) {
      for (const change of entry.changes) {
        if (change.field === 'comments') {
          await this.handleComment(change.value, brandId, brandName, decryptedToken, channel?.orgId);
        }
      }
    }

    if (entry.messaging) {
      for (const msg of entry.messaging) {
        await this.handleMessage(msg, brandId, brandName, decryptedToken, channel?.orgId);
      }
    }
  }

  private async handleComment(
    commentData: any,
    brandId: string,
    brandName: string,
    accessToken: string,
    orgId?: string,
  ) {
    const commentId = commentData.id;
    const text = commentData.text;
    const senderId = commentData.from?.id;
    const mediaId = commentData.media?.id;

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

    if (orgId) {
      await this.prisma.interactionLog.create({
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
        },
      }).catch((e) => this.logger.error(`Failed to log interaction: ${e.message}`));
    }
  }

  private async handleMessage(
    messageData: any,
    brandId: string,
    brandName: string,
    accessToken: string,
    orgId?: string,
  ) {
    const text = messageData.message?.text;
    const senderId = messageData.sender?.id;

    if (!text || !senderId) return;

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

    if (orgId) {
      await this.prisma.interactionLog.create({
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
        },
      }).catch((e) => this.logger.error(`Failed to log interaction: ${e.message}`));
    }
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
      brand_id: data.brand_id || 'default_brand',
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
