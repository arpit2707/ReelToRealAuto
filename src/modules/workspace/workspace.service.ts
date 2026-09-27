import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class WorkspaceService {
  constructor(private readonly prisma: PrismaService) {}

  // Kept in the old product shape for screens that still read it; the data now
  // comes from the catalog (Offering), which replaced the Product table.
  async listProducts(orgId: string) {
    const rows = await this.prisma.offering.findMany({
      where: { orgId, isActive: true },
      orderBy: { createdAt: 'desc' },
      include: { variants: { orderBy: { position: 'asc' } } },
    });
    return rows.map((o) => {
      const stock = o.variants.reduce((n, v) => n + (v.stock ?? 0), 0);
      const tracked = o.variants.some((v) => v.stock != null);
      return {
        id: o.id,
        sku: o.sku || o.id.slice(0, 8),
        title: o.title,
        price: o.priceMin ?? 0,
        currency: o.currency,
        inStock: tracked ? stock > 0 : true,
        stockQuantity: tracked ? stock : 0,
        sizes: o.variants.map((v) => v.label),
        colors: [] as string[],
        checkoutUrl: o.actionUrl || '',
      };
    });
  }

  listAutomationRules(orgId: string) {
    return this.prisma.automationRule.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        triggerType: true,
        keywords: true,
        actions: true,
        isActive: true,
        updatedAt: true,
      },
    });
  }

  listCampaigns(orgId: string) {
    return this.prisma.broadcastCampaign.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        templateName: true,
        status: true,
        scheduledAt: true,
        totalRecipients: true,
        sentCount: true,
        deliveredCount: true,
        readCount: true,
        failedCount: true,
      },
    });
  }

  // A workspace has no wallet row until it is first credited, so report a zero
  // balance rather than 404 — the UI shows a real number either way.
  async getWallet(orgId: string) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { orgId },
      include: { transactions: { orderBy: { createdAt: 'desc' }, take: 20 } },
    });
    if (!wallet) return { balance: 0, currency: 'INR', transactions: [] };
    return {
      balance: wallet.balance,
      currency: wallet.currency,
      updatedAt: wallet.updatedAt,
      transactions: wallet.transactions.map((t) => ({
        id: t.id,
        amount: t.amount,
        type: t.type,
        reason: t.reason,
        createdAt: t.createdAt,
      })),
    };
  }
}
