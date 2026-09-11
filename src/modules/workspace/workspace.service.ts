import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class WorkspaceService {
  constructor(private readonly prisma: PrismaService) {}

  listProducts(orgId: string) {
    return this.prisma.product.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        sku: true,
        title: true,
        price: true,
        currency: true,
        inStock: true,
        stockQuantity: true,
        sizes: true,
        colors: true,
        checkoutUrl: true,
      },
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
