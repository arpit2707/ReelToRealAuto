import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { AiClientService } from '../ai-client/ai-client.service';
import { MetaPublisherService } from '../meta-publisher/meta-publisher.service';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private readonly appSecret = process.env.META_APP_SECRET || '';
  private readonly verifyToken = process.env.META_VERIFY_TOKEN || 'reel2real_verify_secret';

  constructor(
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
      return true; // Dev mode without secret
    }
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
      return false;
    }
    const signature = signatureHeader.substring(7);
    const expected = crypto.createHmac('sha256', this.appSecret).update(rawPayload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  async processWebhookEvent(payload: any) {
    this.logger.log(`Received webhook event: ${JSON.stringify(payload).substring(0, 200)}...`);

    // Extract Instagram comment or message
    if (payload.object === 'instagram' && payload.entry) {
      for (const entry of payload.entry) {
        if (entry.changes) {
          for (const change of entry.changes) {
            if (change.field === 'comments') {
              await this.handleInstagramComment(change.value);
            }
          }
        }
      }
    }
  }

  private async handleInstagramComment(commentData: any) {
    const commentId = commentData.id;
    const text = commentData.text;
    const senderId = commentData.from?.id;
    const mediaId = commentData.media?.id;

    if (!text || !commentId) return;

    this.logger.log(`Processing comment ${commentId}: "${text}" on media ${mediaId}`);

    const aiResponse = await this.aiClient.generateReply({
      brand_id: 'default_brand',
      channel_type: 'instagram',
      event_type: 'comment',
      message_text: text,
      sender_id: senderId || 'anonymous',
      post_context: {
        post_id: mediaId || '',
      },
    });

    if (aiResponse.public_reply) {
      await this.metaPublisher.replyToComment(commentId, aiResponse.public_reply, 'mock_token');
    }

    if (aiResponse.private_dm && senderId) {
      await this.metaPublisher.sendPrivateDm(senderId, aiResponse.private_dm, 'mock_token');
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
