import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { MetaPublisherService } from '../meta-publisher/meta-publisher.service';
import { ConversationService } from '../conversations/conversation.service';
import { ReplyEngineService } from '../catalog/reply-engine.service';
import { PostAiGateService } from '../catalog/post-ai-gate.service';
import {
  DM_CHECK_LINE,
  COMMENT_DM_MAX_AGE_MS,
  privateReplyAllowed,
  withTag,
  type NormalizedComment,
  type Platform,
} from './comments';

// Meta flags accounts that answer many comments in a burst, so each channel
// sends one answer at a time with a random 2–4 s gap, at most 20 a minute.
const GAP_MIN_MS = 2000;
const GAP_MAX_MS = 4000;
const MAX_PER_MINUTE = 20;
// Meta 5xx: two more tries. 4xx (bad token, comment gone, window closed): none.
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 30_000;
const IDLE_POLL_MS = 30_000;
const STUCK_SENDING_MS = 5 * 60 * 1000;

const CRISIS_PUBLIC_FALLBACK =
  'Please call Tele-MANAS 14416 (free, 24x7), or 112 in an emergency 🙏';

export type EnqueueInput = {
  orgId: string;
  channelId: string;
  threadId: string;
  conversationId: string | null;
  comment: NormalizedComment;
  isRoot: boolean;
  kind: 'REPLY' | 'CRISIS';
};

function gap(): number {
  return GAP_MIN_MS + Math.floor(Math.random() * (GAP_MAX_MS - GAP_MIN_MS + 1));
}

/** Drops sentences that claim a DM when none went out. */
function withoutDmClaims(text: string): string {
  return text
    .replace(/[^.!?\n]*\b(?:dm|inbox|message)\b[^.!?\n]*[.!?]?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The comment answers, kept in the database so a restart loses nothing and a
 * comment is never answered twice (CommentReplyJob.commentId is unique). One
 * worker per channel; each job is re-checked right before it is sent.
 */
@Injectable()
export class CommentQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CommentQueueService.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private stopped = false;
  private readonly busy = new Set<string>();
  private readonly nextAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly metaPublisher: MetaPublisherService,
    private readonly conversations: ConversationService,
    private readonly engine: ReplyEngineService,
    private readonly gate: PostAiGateService,
  ) {}

  async onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    // A restart mid-send leaves jobs in SENDING; put them back in line.
    await this.prisma.commentReplyJob
      .updateMany({
        where: {
          status: 'SENDING',
          updatedAt: { lt: new Date(Date.now() - STUCK_SENDING_MS) },
        },
        data: { status: 'QUEUED' },
      })
      .catch((e) =>
        this.logger.warn(`Could not recover comment jobs: ${e.message}`),
      );
    this.schedule(1000);
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(ms: number) {
    if (this.stopped || process.env.NODE_ENV === 'test') return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), Math.max(0, ms));
  }

  /** Queues one answer. False when this comment already has a job. */
  async enqueue(input: EnqueueInput): Promise<boolean> {
    const c = input.comment;
    // Space answers on a channel 2–4 s apart from the last one in line.
    const last = await this.prisma.commentReplyJob.findFirst({
      where: {
        channelId: input.channelId,
        status: { in: ['QUEUED', 'SENDING'] },
      },
      orderBy: { runAfter: 'desc' },
      select: { runAfter: true },
    });
    const runAfter = new Date(
      Math.max(Date.now(), last ? last.runAfter.getTime() + gap() : 0),
    );
    try {
      await this.prisma.commentReplyJob.create({
        data: {
          orgId: input.orgId,
          channelId: input.channelId,
          threadId: input.threadId,
          conversationId: input.conversationId,
          commentId: c.commentId,
          authorId: c.authorId,
          authorName: c.authorName,
          text: c.text.slice(0, 2000),
          isRoot: input.isRoot,
          kind: input.kind,
          commentAt: c.createdAt,
          runAfter,
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') return false;
      throw e;
    }
    this.schedule(runAfter.getTime() - Date.now());
    return true;
  }

  /** Picks due jobs, one per idle channel, within the per-minute limit. */
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      const due = await this.prisma.commentReplyJob.findMany({
        where: { status: 'QUEUED', runAfter: { lte: new Date(now) } },
        orderBy: { runAfter: 'asc' },
        take: 100,
        select: { id: true, channelId: true },
      });
      const started = new Set<string>();
      for (const job of due) {
        const ch = job.channelId;
        if (started.has(ch) || this.busy.has(ch)) continue;
        if ((this.nextAt.get(ch) || 0) > now) continue;
        const lastMinute = await this.prisma.commentReplyJob.count({
          where: { channelId: ch, sentAt: { gt: new Date(now - 60_000) } },
        });
        if (lastMinute >= MAX_PER_MINUTE) {
          this.nextAt.set(ch, now + 5000);
          continue;
        }
        started.add(ch);
        this.busy.add(ch);
        void this.process(job.id)
          .catch((e) =>
            this.logger.error(`Comment job ${job.id} failed: ${e.message}`),
          )
          .finally(() => {
            this.busy.delete(ch);
            this.nextAt.set(ch, Date.now() + gap());
            this.schedule(GAP_MIN_MS);
          });
      }
      const next = await this.prisma.commentReplyJob.findFirst({
        where: { status: 'QUEUED' },
        orderBy: { runAfter: 'asc' },
        select: { runAfter: true },
      });
      this.schedule(
        next
          ? Math.min(
              IDLE_POLL_MS,
              Math.max(500, next.runAfter.getTime() - Date.now()),
            )
          : IDLE_POLL_MS,
      );
    } catch (e: any) {
      this.logger.error(`Comment queue tick failed: ${e.message}`);
      this.schedule(IDLE_POLL_MS);
    } finally {
      this.ticking = false;
    }
  }

  private skip(id: string, reason: string) {
    return this.prisma.commentReplyJob.update({
      where: { id },
      data: { status: 'SKIPPED', error: reason },
    });
  }

  /** Generates, re-checks and sends one answer. Safe to call twice: it claims first. */
  async process(jobId: string) {
    const claimed = await this.prisma.commentReplyJob.updateMany({
      where: { id: jobId, status: 'QUEUED' },
      data: { status: 'SENDING', attempts: { increment: 1 } },
    });
    if (!claimed.count) return;
    const job = await this.prisma.commentReplyJob.findUnique({
      where: { id: jobId },
      include: { thread: true },
    });
    if (!job) return;
    const thread = job.thread;
    const platform = thread.platform as Platform;
    const crisis = job.kind === 'CRISIS';

    const channel = await this.prisma.channel.findFirst({
      where: { id: job.channelId, orgId: job.orgId },
      include: { org: { select: { name: true } } },
    });
    if (!channel || !channel.isActive || channel.status === 'DISCONNECTED')
      return this.skip(job.id, 'channel_unavailable');
    let token: string;
    try {
      token = this.crypto.decrypt(channel.accessTokenEncrypted);
    } catch {
      return this.skip(job.id, 'no_token');
    }

    // Re-check right before spending an AI call and again before sending.
    const stillWanted = async () => {
      const fresh = await this.prisma.commentThread.findUnique({
        where: { id: thread.id },
        select: { status: true },
      });
      if (!fresh || fresh.status === 'DELETED') return 'comment_deleted';
      const self = await this.prisma.commentReplyJob.findUnique({
        where: { id: job.id },
        select: { status: true },
      });
      if (self?.status !== 'SENDING') return 'cancelled';
      if (!crisis && !(await this.gate.isPostAiOn(job.orgId, thread.postId)))
        return 'post_ai_off';
      return null;
    };
    const early = await stillWanted();
    if (early) return this.skip(job.id, early);

    // A retry after the DM already went: do not generate or DM again.
    let publicBase: string | null = job.publicReply;
    let privateDm: string | null = job.privateDm;
    let dmSent = job.dmSent;
    let logged: any = null;
    if (!job.publicReply && !job.dmSent) {
      const outcome = await this.engine.reply({
        orgId: job.orgId,
        brandName: channel.org?.name || channel.name,
        platform,
        eventType: 'comment',
        text: job.text,
        senderId: job.authorId || 'anonymous',
        senderName: job.authorName,
        commentAuthor: job.authorName,
        postId: thread.postId,
        channelId: channel.id,
        conversationId: job.conversationId,
      });
      if (!outcome || (!outcome.public_reply && !outcome.private_dm))
        return this.skip(job.id, 'no_reply');
      publicBase = outcome.public_reply;
      privateDm = outcome.private_dm;
      logged = outcome;
    }

    const late = await stillWanted();
    if (late) return this.skip(job.id, late);

    // Private Reply first, so the public line mentions a DM only if one went.
    let recipientId: string | undefined;
    if (!dmSent && privateDm) {
      const already =
        !job.authorId ||
        (await this.prisma.commentThread.count({
          where: {
            orgId: job.orgId,
            postId: thread.postId,
            rootAuthorId: job.authorId,
            dmSentAt: { not: null },
          },
        })) > 0;
      const allowed = crisis
        ? !job.commentAt ||
          Date.now() - job.commentAt.getTime() < COMMENT_DM_MAX_AGE_MS
        : privateReplyAllowed({
            isRoot: job.isRoot,
            alreadySentOnPost: already,
            commentAt: job.commentAt,
            queuedAt: job.createdAt,
          });
      if (allowed) {
        const dm = await this.metaPublisher.sendPrivateReply(
          job.commentId,
          privateDm,
          token,
        );
        if (dm.ok) {
          dmSent = true;
          recipientId = dm.recipientId;
          await this.onPrivateReplySent(
            job,
            thread,
            channel,
            privateDm,
            dm.recipientId || null,
            platform,
          );
        } else {
          // DMs off, window over, or already replied privately: public only.
          this.logger.warn(
            `Private Reply for comment ${job.commentId} not sent: ${dm.error}`,
          );
        }
      }
    }

    let publicText: string | null = null;
    if (crisis) {
      publicText = withTag(
        platform,
        job.authorName,
        dmSent ? publicBase || '' : CRISIS_PUBLIC_FALLBACK,
      );
    } else {
      let base = (publicBase || '').trim();
      if (!dmSent) base = withoutDmClaims(base);
      const mentionsDm = /\bdm\b/i.test(base);
      const line =
        dmSent && !mentionsDm ? `${base} ${DM_CHECK_LINE}`.trim() : base;
      publicText = line
        ? withTag(platform, job.authorName, line).slice(0, 600)
        : null;
    }

    const sent = publicText
      ? await this.metaPublisher.replyToCommentWithId(
          platform,
          job.commentId,
          publicText,
          token,
        )
      : { ok: true as const, id: undefined, status: 200 };

    if (!sent.ok) {
      const retry =
        (sent.status === 0 || (sent.status || 0) >= 500) &&
        job.attempts < MAX_ATTEMPTS;
      await this.prisma.commentReplyJob.update({
        where: { id: job.id },
        data: {
          status: retry ? 'QUEUED' : 'FAILED',
          runAfter: new Date(Date.now() + RETRY_DELAY_MS * job.attempts),
          publicReply: publicBase,
          privateDm,
          dmSent,
          error: (sent as any).error?.slice(0, 500) || 'send_failed',
        },
      });
      return;
    }

    await this.prisma.commentReplyJob.update({
      where: { id: job.id },
      data: {
        status: 'SENT',
        publicReply: publicText,
        privateDm,
        dmSent,
        replyCommentId: sent.id || null,
        sentAt: new Date(),
        error: null,
      },
    });
    if (publicText && job.conversationId) {
      await this.conversations
        .ingestOutbound(job.orgId, job.conversationId, publicText, 'AI', {
          kind: 'comment',
          commentId: sent.id || null,
          inReplyTo: job.commentId,
          postId: thread.postId,
        })
        .catch((e) =>
          this.logger.error(
            `Could not save comment reply to the inbox: ${e.message}`,
          ),
        );
    }
    await this.prisma.interactionLog
      .create({
        data: {
          orgId: job.orgId,
          channelType: platform,
          eventType: 'COMMENT',
          inboundMessage: job.text,
          senderId: job.authorId || 'anonymous',
          publicReply: publicText,
          privateDm: dmSent ? privateDm : null,
          intent: logged?.intent || (crisis ? 'crisis' : null),
          sentiment: logged?.sentiment || null,
          requiresHuman: Boolean(logged?.requires_human_attention || crisis),
          externalEventId: job.commentId,
          offeringIds: logged?.offering_ids || [],
          action: logged
            ? logged.guarded
              ? 'PRICE_BLOCKED'
              : logged.action
            : null,
        },
      })
      .catch((e) =>
        this.logger.error(`Failed to log comment reply: ${e.message}`),
      );
    return recipientId;
  }

  /** Marks the DM on the thread and saves it in the customer's chat. */
  protected async onPrivateReplySent(
    job: {
      id: string;
      orgId: string;
      conversationId: string | null;
      authorName: string | null;
    },
    thread: { id: string; postId: string },
    channel: { id: string },
    text: string,
    recipientId: string | null,
    platform: Platform,
  ) {
    await this.prisma.commentThread.update({
      where: { id: thread.id },
      data: { dmSentAt: new Date(), dmRecipientId: recipientId },
    });
    await this.prisma.commentReplyJob.update({
      where: { id: job.id },
      data: { dmSent: true, privateDm: text },
    });
    const conversationId = recipientId
      ? await this.conversations
          .linkPrivateReply({
            orgId: job.orgId,
            channelId: channel.id,
            platform,
            recipientId,
            name: job.authorName,
            postId: thread.postId,
          })
          .then((c) => c.id)
          .catch((e) => {
            this.logger.error(
              `Could not link the Private Reply chat: ${e.message}`,
            );
            return job.conversationId;
          })
      : job.conversationId;
    if (conversationId) {
      await this.conversations
        .ingestOutbound(job.orgId, conversationId, text, 'AI')
        .catch((e) =>
          this.logger.error(
            `Could not save the Private Reply to the inbox: ${e.message}`,
          ),
        );
    }
  }
}
