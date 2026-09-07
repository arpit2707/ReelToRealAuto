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
    this.logger.log(`Inbound webhook object: ${payload.object}`);

    if (!payload.entry || !Array.isArray(payload.entry)) return;

    for (const entry of payload.entry) {
      const entryId = entry.id; // Facebook Page ID or Instagram Account ID
      this.logger.log(`Extracting event for Channel Identifier: ${entryId}`);

      // Multi-tenant Channel Lookup
      const channel = await this.prisma.channel.findFirst({
        where: { channelIdentifier: entryId, isActive: true },
        include: { org: true },
      });

      const brandId = channel ? channel.orgId : 'default_brand';
      const brandName = channel?.org?.name || 'Reel2Real Brand';
      let decryptedToken = 'mock_token';

      if (channel?.accessTokenEncrypted) {
        try {
          decryptedToken = this.crypto.decrypt(channel.accessTokenEncrypted);
        } catch (e: any) {
          this.logger.error(`Failed to decrypt token for channel ${channel.id}: ${e.message}`);
        }
      }

      // Handle Instagram Comments / Changes
      if (entry.changes) {
        for (const change of entry.changes) {
          if (change.field === 'comments') {
            await this.handleComment(change.value, brandId, brandName, decryptedToken, channel?.orgId);
          }
        }
      }

      // Handle Messaging / DMs
      if (entry.messaging) {
        for (const msg of entry.messaging) {
          await this.handleMessage(msg, brandId, brandName, decryptedToken, channel?.orgId);
        }
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

    // Persist interaction log to Supabase
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
