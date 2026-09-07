import { Injectable, Logger } from '@nestjs/common';

export interface GenerateReplyPayload {
  brand_id: string;
  channel_type: string; // instagram, facebook, whatsapp
  event_type: string;   // comment, dm
  message_text: string;
  sender_id: string;
  post_context?: {
    post_id: string;
    caption?: string;
    tagged_product_sku?: string;
  };
  brand_persona?: {
    brand_name: string;
    tone?: string;
    language_mode?: string;
    emoji_density?: string;
    custom_instructions?: string;
  };
}

export interface GeneratedReplyResult {
  public_reply: string | null;
  private_dm: string | null;
  intent: string;
  sentiment: string;
  requires_human_attention: boolean;
  detected_product_sku?: string | null;
  reasoning?: string | null;
}

@Injectable()
export class AiClientService {
  private readonly logger = new Logger(AiClientService.name);
  private readonly aiServiceUrl = process.env.AI_SERVICE_URL || 'http://127.0.0.1:8000/api/v1/generate-reply';

  async generateReply(payload: GenerateReplyPayload): Promise<GeneratedReplyResult> {
    try {
      this.logger.log(`Invoking Personalised-AI for sender ${payload.sender_id} on ${payload.channel_type}`);
      const response = await fetch(this.aiServiceUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`AI service responded with HTTP ${response.status}: ${await response.text()}`);
      }

      return (await response.json()) as GeneratedReplyResult;
    } catch (error: any) {
      this.logger.error(`Failed to reach Personalised-AI microservice: ${error.message}`);
      // Fallback
      return {
        public_reply: 'Hey! Sent you a DM with the complete details! ✨🛍️',
        private_dm: 'Hello! Thank you for reaching out. We will get back to you with the details shortly.',
        intent: 'fallback',
        sentiment: 'neutral',
        requires_human_attention: false,
      };
    }
  }
}
