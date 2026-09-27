import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MetaPublisherService } from '../meta-publisher/meta-publisher.service';
import { industryOf } from './industries';

const LEAD_STATUSES = ['NEW', 'CONTACTED', 'BOOKED', 'LOST'];

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metaPublisher: MetaPublisherService,
  ) {}

  list(orgId: string, status?: string) {
    return this.prisma.lead.findMany({
      where: { orgId, ...(status ? { status } : {}) },
      include: { offering: { select: { id: true, title: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async update(
    orgId: string,
    id: string,
    input: { status?: string; notes?: string | null },
  ) {
    const lead = await this.prisma.lead.findFirst({ where: { id, orgId } });
    if (!lead) throw new NotFoundException('Lead not found');
    if (input.status && !LEAD_STATUSES.includes(input.status)) {
      throw new BadRequestException(
        `Status must be one of ${LEAD_STATUSES.join(', ')}`,
      );
    }
    return this.prisma.lead.update({
      where: { id },
      data: { status: input.status, notes: input.notes },
      include: { offering: { select: { id: true, title: true } } },
    });
  }

  /**
   * One lead per conversation and offering; later messages fill in more
   * details instead of creating duplicates. The seller hears about a lead once,
   * when it first has every detail the industry asks for.
   */
  async upsertFromConversation(input: {
    orgId: string;
    conversationId: string;
    offeringId: string | null;
    platform: string;
    contactName?: string | null;
    contactHandle?: string | null;
    fields: Record<string, string>;
    complete: boolean;
  }) {
    const existing = await this.prisma.lead.findFirst({
      where: {
        conversationId: input.conversationId,
        offeringId: input.offeringId,
      },
    });
    const fields = {
      ...((existing?.fields as Record<string, string>) || {}),
      ...input.fields,
    } as Prisma.InputJsonValue;
    const lead = existing
      ? await this.prisma.lead.update({
          where: { id: existing.id },
          data: { fields },
        })
      : await this.prisma.lead.create({
          data: {
            orgId: input.orgId,
            conversationId: input.conversationId,
            offeringId: input.offeringId,
            platform: input.platform,
            contactName: input.contactName || null,
            contactHandle: input.contactHandle || null,
            fields,
          },
        });
    if (input.complete && !lead.alertSentAt) {
      const sent = await this.alertSeller(lead.id).catch((e) => {
        this.logger.warn(`Lead alert failed for ${lead.id}: ${e.message}`);
        return false;
      });
      if (sent)
        await this.prisma.lead.update({
          where: { id: lead.id },
          data: { alertSentAt: new Date() },
        });
    }
    return lead;
  }

  private sender() {
    const phoneNumberId =
      process.env.STORY_WA_PHONE_NUMBER_ID ||
      process.env.WHATSAPP_PHONE_NUMBER_ID;
    const accessToken =
      process.env.STORY_WA_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
    return phoneNumberId && accessToken ? { phoneNumberId, accessToken } : null;
  }

  /**
   * Tells the seller on their own WhatsApp. A business-initiated message needs
   * an approved template (LEAD_ALERT_TEMPLATE, body params: name, details);
   * without one this falls back to a plain message, which WhatsApp only
   * delivers inside the 24-hour window.
   */
  async alertSeller(leadId: string): Promise<boolean> {
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      include: {
        offering: { select: { title: true } },
        org: { include: { businessProfile: true } },
      },
    });
    const to = lead?.org.businessProfile?.alertPhone;
    const sender = this.sender();
    if (!lead || !to || !sender) return false;

    const template = industryOf(lead.org.businessProfile?.industry);
    const fields = (lead.fields as Record<string, string>) || {};
    const details = [
      lead.offering?.title,
      ...template.leadFields
        .filter((f) => fields[f.key])
        .map((f) => `${f.label}: ${fields[f.key]}`),
      `via ${lead.platform.toLowerCase()}`,
    ]
      .filter(Boolean)
      .join(' · ');
    const name = lead.contactName || lead.contactHandle || 'A customer';

    const templateName = process.env.LEAD_ALERT_TEMPLATE;
    if (templateName) {
      return this.metaPublisher.sendWhatsAppTemplate(
        sender.phoneNumberId,
        to,
        templateName,
        process.env.LEAD_ALERT_TEMPLATE_LANG || 'en',
        [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: name },
              { type: 'text', text: details.slice(0, 900) },
            ],
          },
        ],
        sender.accessToken,
      );
    }
    return this.metaPublisher.sendWhatsAppMessage(
      sender.phoneNumberId,
      to,
      `New lead on Reel2Real: ${name}\n${details}\nOpen Leads in your dashboard to reply.`,
      sender.accessToken,
      undefined,
    );
  }
}
