import { Injectable, Logger, Optional } from '@nestjs/common';
import { AiProviderService } from '../ai-providers/ai-provider.service';

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
  // Plain DMs: posts the seller highlights, and the links a reply may share.
  spotlight?: Array<{
    post_id: string;
    label: string | null;
    caption: string | null;
    permalink: string | null;
    offering_ids: string[];
  }>;
  allowed_links?: string[];
  // Who a public comment reply answers (the backend adds the @tag).
  comment_author?: string;
  // We only call when this chat should get an AI answer (our own hand-off
  // pause is over or the seller pressed Resume), so reopen it on the AI side.
  resume_if_pending?: boolean;
  // The provider, key and model chosen for DM replies (superadmin or workspace).
  // Left out when the AI service's own Gemini key should answer, as before.
  llm?: { provider: 'OPENAI' | 'GEMINI' | 'CLAUDE'; api_key: string; model: string };
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
  // PRODUCTS or SERVICES once a customer on a "both" page made it clear.
  offering_type?: string | null;
}

@Injectable()
export class AiClientService {
  private readonly logger = new Logger(AiClientService.name);
  private readonly aiServiceUrl = process.env.AI_SERVICE_URL || 'http://127.0.0.1:8000/api/v1/generate-reply';

  constructor(@Optional() private readonly providers?: AiProviderService) {}

  private async withProvider(payload: GenerateReplyPayload): Promise<GenerateReplyPayload> {
    if (!this.providers || !payload.brand_id || payload.llm) return payload;
    try {
      const ai = await this.providers.resolve(payload.brand_id, 'DM_REPLIES');
      if (!ai || (ai.source === 'ENV' && ai.provider === 'GEMINI')) return payload;
      return { ...payload, llm: { provider: ai.provider, api_key: ai.apiKey, model: ai.model } };
    } catch (e: any) {
      this.logger.warn(`AI provider lookup failed, using the AI service default: ${e.message}`);
      return payload;
    }
  }

  /**
   * The AI service sleeps on Render's free plan when idle. While it wakes,
   * Render answers 502/503/504 itself for up to about a minute, so those (and
   * dropped connections) are retried before the chat is handed to a human.
   */
  private async post(body: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let response: Response | null = null;
      let failure: string;
      try {
        response = await fetch(this.aiServiceUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Must match AI_SERVICE_TOKEN on the AI service, which rejects calls without it.
            ...(process.env.AI_SERVICE_TOKEN ? { 'X-AI-Service-Token': process.env.AI_SERVICE_TOKEN } : {}),
          },
          body,
        });
        if (response.ok) return response;
        failure = `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`;
      } catch (e: any) {
        failure = e?.message || 'network error';
      }
      const wait = WAKE_RETRY_MS[attempt];
      const retryable = !response || WAKE_STATUSES.has(response.status);
      if (!retryable || wait === undefined) throw new Error(`AI service responded with ${failure}`);
      this.logger.warn(`AI service not ready (${failure.slice(0, 60)}), retrying in ${wait / 1000}s`);
      await this.sleep(wait);
    }
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async generateReply(input: GenerateReplyPayload): Promise<GeneratedReplyResult> {
    try {
      const payload = await this.withProvider(input);
      this.logger.log(
        `Invoking Personalised-AI for sender ${payload.sender_id} on ${payload.channel_type}` +
          (payload.llm ? ` via ${payload.llm.provider}` : ''),
      );
      const response = await this.post(JSON.stringify(payload));
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

const WAKE_STATUSES = new Set([502, 503, 504]);
// About 90 seconds in all: enough for a Render free instance to spin up.
const WAKE_RETRY_MS = [10_000, 20_000, 30_000, 30_000];
