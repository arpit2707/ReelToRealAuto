import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

const COD_STATUSES = ['PENDING', 'CONFIRMED', 'CANCELLED', 'NOT_APPLICABLE'];
const CART_STATUSES = ['PENDING', 'RECOVERED', 'COMPLETED', 'EXHAUSTED'];
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;

export interface StoreSettingsInput {
  codConfirmationEnabled?: boolean;
  abandonedCartEnabled?: boolean;
  codTemplateName?: string | null;
  cartTemplateNames?: string[];
  templateLanguage?: string;
}

@Injectable()
export class CommerceService {
  constructor(private readonly prisma: PrismaService) {}

  listOrders(orgId: string, codStatus?: string, limit = 50) {
    if (codStatus && !COD_STATUSES.includes(codStatus)) {
      throw new BadRequestException(`codStatus must be one of ${COD_STATUSES.join(', ')}`);
    }
    return this.prisma.ecommerceOrder.findMany({
      where: { orgId, ...(codStatus ? { codStatus } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
      select: {
        id: true,
        orderId: true,
        customerName: true,
        customerPhone: true,
        itemsSummary: true,
        totalAmount: true,
        currency: true,
        paymentMethod: true,
        orderStatus: true,
        codStatus: true,
        confirmationSentAt: true,
        confirmationError: true,
        confirmedAt: true,
        cancelledAt: true,
        createdAt: true,
      },
    });
  }

  listCarts(orgId: string, status?: string, limit = 50) {
    if (status && !CART_STATUSES.includes(status)) {
      throw new BadRequestException(`status must be one of ${CART_STATUSES.join(', ')}`);
    }
    return this.prisma.abandonedCart.findMany({
      where: { orgId, ...(status ? { recoveryStatus: status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
      select: {
        id: true,
        cartToken: true,
        customerName: true,
        customerPhone: true,
        itemsSummary: true,
        cartValue: true,
        currency: true,
        checkoutUrl: true,
        recoveryStatus: true,
        reminderStage: true,
        lastReminderSentAt: true,
        lastReminderError: true,
        recoveredOrderId: true,
        recoveredAt: true,
        createdAt: true,
      },
    });
  }

  /** Headline numbers for the Commerce tab over the last `days` days. */
  async stats(orgId: string, days = 30) {
    const since = new Date(Date.now() - Math.min(Math.max(days, 1), 365) * 24 * 60 * 60 * 1000);

    const [codGroups, cancelled, cartGroups, recovered] = await Promise.all([
      this.prisma.ecommerceOrder.groupBy({
        by: ['codStatus'],
        where: { orgId, paymentMethod: 'COD', createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.ecommerceOrder.aggregate({
        where: {
          orgId,
          paymentMethod: 'COD',
          codStatus: 'CANCELLED',
          createdAt: { gte: since },
        },
        _sum: { totalAmount: true },
      }),
      this.prisma.abandonedCart.groupBy({
        by: ['recoveryStatus'],
        where: { orgId, createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.abandonedCart.aggregate({
        where: {
          orgId,
          recoveryStatus: 'RECOVERED',
          createdAt: { gte: since },
        },
        _sum: { cartValue: true },
      }),
    ]);

    const cod = Object.fromEntries(codGroups.map((g) => [g.codStatus, g._count._all]));
    const carts = Object.fromEntries(cartGroups.map((g) => [g.recoveryStatus, g._count._all]));
    const codTotal = codGroups.reduce((n, g) => n + g._count._all, 0);
    const cartTotal = cartGroups.reduce((n, g) => n + g._count._all, 0);
    const codAnswered = (cod.CONFIRMED || 0) + (cod.CANCELLED || 0);
    const cartsRecovered = carts.RECOVERED || 0;

    return {
      days,
      cod: {
        total: codTotal,
        confirmed: cod.CONFIRMED || 0,
        cancelled: cod.CANCELLED || 0,
        pending: cod.PENDING || 0,
        responseRate: codTotal ? codAnswered / codTotal : 0,
        // Value of COD orders the customer cancelled before dispatch: shipping that
        // would otherwise have gone out and likely come back as RTO.
        cancelledValue: cancelled._sum.totalAmount || 0,
      },
      carts: {
        total: cartTotal,
        recovered: cartsRecovered,
        pending: carts.PENDING || 0,
        exhausted: carts.EXHAUSTED || 0,
        recoveryRate: cartTotal ? cartsRecovered / cartTotal : 0,
        recoveredValue: recovered._sum.cartValue || 0,
      },
    };
  }

  async getSettings(orgId: string) {
    const store = await this.prisma.shopifyStore.findFirst({
      where: { orgId },
      orderBy: { createdAt: 'asc' },
    });
    if (!store) return { connected: false };
    return {
      connected: true,
      shopDomain: store.shopDomain,
      codConfirmationEnabled: store.codConfirmationEnabled,
      abandonedCartEnabled: store.abandonedCartEnabled,
      codTemplateName: store.codTemplateName,
      cartTemplateNames: store.cartTemplateNames,
      templateLanguage: store.templateLanguage,
    };
  }

  async updateSettings(orgId: string, input: StoreSettingsInput) {
    const store = await this.prisma.shopifyStore.findFirst({
      where: { orgId },
      orderBy: { createdAt: 'asc' },
    });
    if (!store) throw new NotFoundException('No Shopify store connected');

    const data: StoreSettingsInput = {};
    if (input.codConfirmationEnabled !== undefined) {
      data.codConfirmationEnabled = this.bool(input.codConfirmationEnabled, 'codConfirmationEnabled');
    }
    if (input.abandonedCartEnabled !== undefined) {
      data.abandonedCartEnabled = this.bool(input.abandonedCartEnabled, 'abandonedCartEnabled');
    }
    if (input.codTemplateName !== undefined) {
      data.codTemplateName = input.codTemplateName ? this.templateName(input.codTemplateName) : null;
    }
    if (input.cartTemplateNames !== undefined) {
      if (!Array.isArray(input.cartTemplateNames) || input.cartTemplateNames.length > 3) {
        throw new BadRequestException('cartTemplateNames must be an array of up to 3 names (stage 1, 2, 3)');
      }
      data.cartTemplateNames = input.cartTemplateNames.map((n) => (n ? this.templateName(n) : ''));
    }
    if (input.templateLanguage !== undefined) {
      if (
        typeof input.templateLanguage !== 'string' ||
        !/^[a-z]{2}(_[A-Z]{2})?$/.test(input.templateLanguage)
      ) {
        throw new BadRequestException('templateLanguage must look like "en" or "en_US"');
      }
      data.templateLanguage = input.templateLanguage;
    }

    await this.prisma.shopifyStore.update({ where: { id: store.id }, data });
    return this.getSettings(orgId);
  }

  private bool(value: unknown, field: string): boolean {
    if (typeof value !== 'boolean') throw new BadRequestException(`${field} must be true or false`);
    return value;
  }

  private templateName(value: unknown): string {
    if (typeof value !== 'string' || !TEMPLATE_NAME.test(value)) {
      throw new BadRequestException('Template names use lowercase letters, digits and underscores');
    }
    return value;
  }
}
