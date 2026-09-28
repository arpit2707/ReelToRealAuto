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
    // The seller's own note about the post ("offer till Sunday").
    note?: string;
    tagged_product_sku?: string;
  };
  brand_persona?: {
    brand_name: string;
    tone?: string;
    language_mode?: string;
    emoji_density?: string;
    custom_instructions?: string;
  };
  // Catalog-aware context built by ReplyContextService. Older AI service
  // versions ignore these fields.
  business?: Record<string, unknown>;
  playbook?: {
    goal: string;
    lead_fields: Array<{ key: string; label: string; ask: string }>;
    rules: string[];
  };
  offerings?: Array<Record<string, unknown>>;
  goal_state?: Record<string, unknown>;
  recent_messages?: Array<{ from: string; text: string }>;
  // Who a public comment reply answers (the backend adds the @tag).
  comment_author?: string;
  // We only call when this chat should get an AI answer (our own hand-off
  // pause is over or the seller pressed Resume), so reopen it on the AI side.
  resume_if_pending?: boolean;
}

// SEND_LINK: shared a price and link. ASK_FIELD: asked for a missing lead
// detail. CREATE_LEAD: every required detail is in. HANDOFF: a person must take
// over. ANSWER: anything else.
export type ReplyAction = 'SEND_LINK' | 'ASK_FIELD' | 'CREATE_LEAD' | 'HANDOFF' | 'ANSWER';

export interface GeneratedReplyResult {
  public_reply: string | null;
  private_dm: string | null;
  intent: string;
  sentiment: string;
  requires_human_attention: boolean;
  detected_product_sku?: string | null;
  reasoning?: string | null;
  action?: ReplyAction | null;
  offering_ids?: string[] | null;
  collected_fields?: Record<string, string> | null;
  // Why the AI handed over: human_request, complaint, order_support,
  // purchase_assistance, missing_information, generation_unavailable, …
  handoff_reason?: string | null;
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
        headers: {
          'Content-Type': 'application/json',
          // Must match AI_SERVICE_TOKEN on the AI service, which rejects calls without it.
          ...(process.env.AI_SERVICE_TOKEN ? { 'X-AI-Service-Token': process.env.AI_SERVICE_TOKEN } : {}),
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`AI service responded with HTTP ${response.status}: ${await response.text()}`);
      }

      return (await response.json()) as GeneratedReplyResult;
    } catch (error: any) {
      this.logger.error(
        `Failed to reach Personalised-AI microservice: ${error.message}`,
      );
      // No canned auto-reply: a public "sent you a DM" with an empty DM behind
      // it, repeated on every message, reads as spam. Leave it for a human.
      return {
        public_reply: null,
        private_dm: null,
        intent: 'ai_unavailable',
        sentiment: 'neutral',
        requires_human_attention: true,
      };
    }
  }
}
