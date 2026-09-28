import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { AiClientService } from '../ai-client/ai-client.service';
import { MetaPublisherService } from '../meta-publisher/meta-publisher.service';
import { ShopifyService } from '../shopify/shopify.service';
import { ConversationService } from '../conversations/conversation.service';
import { StoriesService } from '../stories/stories.service';
import { ReplyEngineService, type ReplyOutcome } from '../catalog/reply-engine.service';
import { PostTaggingService } from '../catalog/post-tagging.service';
import { hmacSha256Hex, timingSafeEqualString } from '../../common/hmac';
import { CommentPipelineService } from './comment-pipeline.service';
import { normalizeFacebook, normalizeInstagram } from './comments';
import { describeAttachments, extractPostRef, normalizePermalink, type PostRef } from './post-ref';
import { PostAiGateService } from '../catalog/post-ai-gate.service';

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
    private readonly stories: StoriesService,
    private readonly replies: ReplyEngineService,
    private readonly postTagging: PostTaggingService,
    @Optional() private readonly comments?: CommentPipelineService,
    @Optional() private readonly gate?: PostAiGateService,
  ) {}

  /** The post a DM refers to, by id or by its link. */
  private async resolvePostRef(orgId: string, ref: PostRef | null): Promise<string | null> {
    if (!ref) return null;
    if (ref.postId) return ref.postId;
    if (!ref.permalink) return null;
    const post = await this.prisma.socialPost
      .findFirst({
        where: { orgId, permalink: { startsWith: normalizePermalink(ref.permalink) } },
        select: { postId: true },
      })
      .catch(() => null);
    return post?.postId || null;
  }

  /**
   * Saves an Instagram / Messenger DM (with or without text) and works out
   * what the AI should answer. Null means: saved, nothing to answer. A share
   * or story reply without text is answered only when that post's AI is on.
   */
  private async prepareDm(input: {
    platform: 'INSTAGRAM' | 'FACEBOOK';
    orgId: string;
    channelId: string;
    senderId: string;
    msg: any;
    mid?: string;
  }): Promise<{ conversationId: string; text: string; postId: string | null } | null> {
    const typed: string | undefined = input.msg.message?.text || input.msg.postback?.title;
    const ref = extractPostRef(input.msg);
    const described = describeAttachments(input.msg);
    if (!typed && !ref && !described) return null;
    const conversation = await this.conversations.ingestInbound({
      orgId: input.orgId,
      channelId: input.channelId,
      platform: input.platform,
      peerId: input.senderId,
      text: typed || described || '[Message]',
      platformMessageId: input.mid,
      ...(typed ? {} : { type: ref ? 'SHARE' : 'ATTACHMENT' }),
    });
    const postId = await this.resolvePostRef(input.orgId, ref);
    if (postId && ref) {
      await this.conversations
        .markSource(conversation.id, postId, input.platform, ref.kind)
        .catch((e) => this.logger.warn(`Could not record the chat's post: ${e.message}`));
    }
    if (!typed) {
      const on = postId && this.gate ? await this.gate.isPostAiOn(input.orgId, postId) : false;
      if (!on) return null;
    }
    return {
      conversationId: conversation.id,
      // The AI sees a shared post without words as a question about it.
      text: typed || '(The customer shared this post without a message.)',
      postId,
    };
  }

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

        // Daily story picks arrive on the Reel2Real number, which need not be a
        // merchant channel, so route them before the channel lookup below.
        const messages: any[] = [];
        for (const msg of change.value.messages || []) {
          // "Kya isme X hai?" answers from a seller about their new post.
          if (this.postTagging.isTagAnswer(msg)) {
            if (!(await this.claimEvent(msg.id, 'whatsapp_message'))) continue;
            await this.postTagging
              .handleTagAnswer(msg)
              .catch((e) => this.logger.error(`Post tag answer failed: ${e.message}`));
            continue;
          }
          if (!(await this.stories.isStoryReply(msg, phoneNumberId))) {
            messages.push(msg);
            continue;
          }
          if (!(await this.claimEvent(msg.id, 'whatsapp_message'))) continue;
          await this.stories
            .handleWhatsAppReply(msg)
            .catch((e) => this.logger.error(`Story reply handling failed: ${e.message}`));
        }
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
          // Session messages report taps as interactive.button_reply; template quick
          // replies arrive as type "button" with the payload we set at send time.
          const buttonId = msg.interactive?.button_reply?.id || msg.button?.payload;
          const text =
            msg.text?.body ||
            msg.interactive?.button_reply?.title ||
            msg.interactive?.list_reply?.title ||
            msg.button?.text;
          if (!fromWaId) continue;
          if (!text) {
            // Photos, voice notes, locations: saved for the seller, not answered.
            if (msg.type) {
              await this.conversations.ingestInbound({
                orgId: channel.orgId,
                channelId: channel.id,
                platform: 'WHATSAPP',
                peerId: fromWaId,
                text: `[${String(msg.type).replace(/^./, (c: string) => c.toUpperCase())}]`,
                platformMessageId: msg.id,
                type: 'ATTACHMENT',
              });
            }
            continue;
          }

          const conversation = await this.conversations.ingestInbound({
            orgId: channel.orgId,
            channelId: channel.id,
            platform: 'WHATSAPP',
            peerId: fromWaId,
            text,
            platformMessageId: msg.id,
          });

          if (buttonId && (buttonId.startsWith('COD_CONFIRM_') || buttonId.startsWith('COD_CANCEL_'))) {
            await this.shopifyService.handleCodButtonCallback(
              buttonId,
              fromWaId,
              phoneNumberId,
              decryptedToken,
              channel.orgId,
            );
            continue;
          }

          this.logger.log(`WhatsApp message from ${fromWaId}: "${text}" [Brand: ${brandName}]`);

          const aiResponse = await this.replies.reply({
            orgId: brandId,
            brandName,
            platform: 'WHATSAPP',
            eventType: 'dm',
            text,
            senderId: fromWaId,
            senderName: msg.profile?.name || change.value.contacts?.[0]?.profile?.name || null,
            conversationId: conversation.id,
            channelId: channel.id,
          });
          if (!aiResponse) continue;

          const replyMessage = aiResponse.private_dm || aiResponse.public_reply;

          if (replyMessage) {
            const sent = await this.metaPublisher.sendWhatsAppMessage(
              phoneNumberId,
              fromWaId,
              replyMessage,
              decryptedToken,
              undefined,
            );
            if (sent)
              await this.recordAutoReply(
                channel.orgId,
                conversation.id,
                replyMessage,
              );
          }

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
                ...this.outcomeLog(aiResponse),
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
        // The Page published something: tag it now and ask the seller, instead
        // of waiting for the daily tagging run or its first comment.
        if (
          change.field === 'feed' &&
          change.value?.verb === 'add' &&
          ['photo', 'status', 'video', 'post'].includes(change.value?.item) &&
          String(change.value?.from?.id || '') === String(pageId) &&
          change.value?.post_id
        ) {
          const postId = String(change.value.post_id);
          if (!(await this.claimEvent(`newpost:${postId}`, 'facebook_post'))) continue;
          setImmediate(() => {
            this.postTagging
              .ensurePostContext(brandId, channel.id, postId)
              .catch((e) => this.logger.warn(`Tagging new Page post ${postId} failed: ${e.message}`));
          });
          continue;
        }

        if (change.field === 'feed' && change.value?.item === 'comment') {
          const comment = normalizeFacebook(change.value);
          if (!comment || !this.comments) continue;
          // Deletes and edits carry the same comment id as the original.
          if (comment.verb === 'add' && !(await this.claimEvent(comment.commentId, 'facebook_comment'))) continue;
          await this.comments
            .handle(
              { id: channel.id, orgId: channel.orgId, channelIdentifier: pageId },
              comment,
            )
            .catch((e) => this.logger.error(`Facebook comment ${comment.commentId} failed: ${e.message}`));
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
        if (!senderId) continue;

        const dm = await this.prepareDm({
          platform: 'FACEBOOK',
          orgId: channel.orgId,
          channelId: channel.id,
          senderId,
          msg,
          mid,
        });
        if (!dm) continue;
        const text = dm.text;
        const conversation = { id: dm.conversationId };

        const aiResponse = await this.replies.reply({
          orgId: brandId,
          brandName,
          platform: 'FACEBOOK',
          eventType: 'dm',
          text,
          senderId,
          postId: dm.postId,
          conversationId: conversation.id,
          channelId: channel.id,
        });
        if (!aiResponse) continue;

        if (aiResponse.private_dm) {
          const sent = await this.metaPublisher.sendFacebookMessengerDm(
            pageId,
            senderId,
            aiResponse.private_dm,
            decryptedToken,
          );
          if (sent)
            await this.recordAutoReply(
              channel.orgId,
              conversation.id,
              aiResponse.private_dm,
            );
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
              ...this.outcomeLog(aiResponse),
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
          await this.handleComment(change.value, channel.orgId, entryId, channel.id);
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
    orgId: string,
    igAccountId: string,
    channelId: string,
  ) {
    const comment = normalizeInstagram(commentData);
    if (!comment || !this.comments) return;
    if (!(await this.claimEvent(comment.commentId, 'instagram_comment'))) return;
    this.logger.log(`Processing comment [${comment.commentId}] for org ${orgId}`);
    await this.comments
      .handle({ id: channelId, orgId, channelIdentifier: igAccountId }, comment)
      .catch((e) => this.logger.error(`Instagram comment ${comment.commentId} failed: ${e.message}`));
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

    const senderId = messageData.sender?.id;
    if (senderId && senderId === igAccountId) return;

    const mid = messageData.message?.mid;
    if (!(await this.claimEvent(mid, 'instagram_dm'))) return;
    if (!senderId) return;

    const dm = await this.prepareDm({
      platform: 'INSTAGRAM',
      orgId,
      channelId,
      senderId,
      msg: messageData,
      mid,
    });
    if (!dm) return;
    const text = dm.text;
    const conversation = { id: dm.conversationId };

    this.logger.log(`Processing DM from [${senderId}] on Brand: ${brandName}`);

    const aiResponse = await this.replies.reply({
      orgId,
      brandName,
      platform: 'INSTAGRAM',
      eventType: 'dm',
      text,
      senderId,
      // A story reply, shared post, ad or link carries the post it is about.
      postId: dm.postId,
      conversationId: conversation.id,
      channelId,
    });
    if (!aiResponse) return;

    if (aiResponse.private_dm) {
      const sent = await this.metaPublisher.sendPrivateDm(
        senderId,
        aiResponse.private_dm,
        accessToken,
      );
      if (sent)
        await this.recordAutoReply(
          orgId,
          conversation.id,
          aiResponse.private_dm,
        );
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
          ...this.outcomeLog(aiResponse),
        },
      })
      .catch((e) => this.logger.error(`Failed to log interaction: ${e.message}`));
  }

  private outcomeLog(outcome: ReplyOutcome) {
    return { offeringIds: outcome.offering_ids, action: outcome.guarded ? 'PRICE_BLOCKED' : outcome.action };
  }

  // Auto-replies belong in the thread too, or the inbox shows only one side.
  private async recordAutoReply(
    orgId: string,
    conversationId: string,
    text: string,
  ) {
    await this.conversations
      .ingestOutbound(orgId, conversationId, text, 'AI')
      .catch((e) =>
        this.logger.error(`Failed to record auto-reply: ${e.message}`),
      );
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
