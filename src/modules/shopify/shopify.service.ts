import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { MetaPublisherService } from '../meta-publisher/meta-publisher.service';
import { hmacSha256Base64, timingSafeEqualString } from '../../common/hmac';

const SHOPIFY_API_VERSION = '2024-10';
const CART_TICK_MS = 60_000;
const STAGE1_MS = 15 * 60 * 1000;
const STAGE2_MS = 6 * 60 * 60 * 1000;
const STAGE3_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class ShopifyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShopifyService.name);
  private cartTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly metaPublisher: MetaPublisherService,
  ) {}

  onModuleInit() {
    this.cartTimer = setInterval(() => {
      this.processAbandonedCartReminders().catch((err) =>
        this.logger.error(`Abandoned cart scheduler failed: ${err?.message || err}`),
      );
    }, CART_TICK_MS);
  }

  onModuleDestroy() {
    if (this.cartTimer) {
      clearInterval(this.cartTimer);
      this.cartTimer = null;
    }
  }

  async verifyWebhookHmac(
    hmacHeader: string | undefined,
    rawBody: Buffer | undefined,
    shopDomain?: string,
  ): Promise<boolean> {
    if (!hmacHeader || !rawBody || rawBody.length === 0) {
      return false;
    }

    let storeSecret: string | undefined;
    if (shopDomain) {
      const store = await this.prisma.shopifyStore.findFirst({
        where: { shopDomain },
      });
      storeSecret = store?.webhookSecret || undefined;
    }

    const secret = storeSecret || process.env.SHOPIFY_API_SECRET;
    if (!secret) {
      this.logger.error('No Shopify webhook secret available; rejecting webhook');
      return false;
    }

    const expected = hmacSha256Base64(secret, rawBody);
    return timingSafeEqualString(hmacHeader, expected);
  }

  private async resolveStore(shopDomain?: string) {
    if (!shopDomain) {
      return null;
    }
    return this.prisma.shopifyStore.findFirst({
      where: { shopDomain },
      include: { org: true },
    });
  }

  private decryptToken(encrypted?: string | null): string | null {
    if (!encrypted) return null;
    try {
      return this.crypto.decrypt(encrypted);
    } catch (e: any) {
      this.logger.error(`Failed to decrypt Shopify/WhatsApp token: ${e.message}`);
      return null;
    }
  }

  private formatPhone(customerPhone: string): string {
    const cleanPhone = customerPhone.replace(/[^0-9]/g, '');
    return cleanPhone.length === 10 ? `91${cleanPhone}` : cleanPhone;
  }

  private summarizeItems(lineItems: any[] | undefined): string | null {
    if (!Array.isArray(lineItems) || lineItems.length === 0) return null;
    const summary = lineItems
      .map((li) => `${li.title || li.name || 'Item'}${li.quantity > 1 ? ` x${li.quantity}` : ''}`)
      .join(', ');
    return summary.length > 140 ? `${summary.slice(0, 137)}...` : summary;
  }

  // Shopify reports the gateway by display name, e.g. "Cash on Delivery (COD)".
  isCodOrder(orderPayload: any): boolean {
    const names: string[] = [
      orderPayload.gateway,
      orderPayload.payment_gateway,
      ...(orderPayload.payment_gateway_names || []),
    ].filter(Boolean);
    return names.some((n) => /\bcod\b|cash[\s_-]*on[\s_-]*delivery/i.test(String(n)));
  }

  // Meta accepts free-form messages only inside the 24h window that opens when the
  // customer last wrote to us. Outside it, only approved templates go through.
  private async hasOpenServiceWindow(orgId: string, waId: string): Promise<boolean> {
    const open = await this.prisma.conversation.findFirst({
      where: {
        orgId,
        channel: { platform: 'WHATSAPP' },
        contact: { platformUserId: waId },
        windowExpiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    return !!open;
  }

  private async resolveWhatsAppChannel(orgId: string) {
    const channel = await this.prisma.channel.findFirst({
      where: { orgId, platform: 'WHATSAPP', isActive: true },
    });
    if (!channel) return null;
    const accessToken = this.decryptToken(channel.accessTokenEncrypted);
    if (!accessToken) return null;
    return { phoneNumberId: channel.channelIdentifier, accessToken };
  }

  async handleOrderCreated(orderPayload: any, shopDomain?: string) {
    const orderId = String(orderPayload.id || orderPayload.order_number || '');
    const orderName = String(orderPayload.name || orderPayload.order_number || orderId);
    const isCod = this.isCodOrder(orderPayload);

    const customerPhone =
      orderPayload.customer?.phone ||
      orderPayload.shipping_address?.phone ||
      orderPayload.billing_address?.phone ||
      orderPayload.phone ||
      '';
    const customerName =
      orderPayload.customer?.first_name || orderPayload.shipping_address?.first_name || 'Customer';
    const totalAmount = parseFloat(orderPayload.total_price || '0');
    const currency = orderPayload.currency || 'INR';
    const checkoutToken = orderPayload.checkout_token ? String(orderPayload.checkout_token) : null;
    const itemsSummary = this.summarizeItems(orderPayload.line_items);

    this.logger.log(`Shopify order created: #${orderId}, isCOD: ${isCod}`);

    const store = await this.resolveStore(shopDomain);
    if (!store) {
      this.logger.warn(`No ShopifyStore for domain ${shopDomain}; skipping order ${orderId}`);
      return { success: false, reason: 'UNKNOWN_STORE' };
    }
    const orgId = store.orgId;

    await this.markCartRecovered(orgId, checkoutToken, orderId);

    if (!customerPhone) {
      this.logger.warn(`No phone number found for order #${orderId}. Skipping WhatsApp notification.`);
      return { success: false, reason: 'NO_PHONE' };
    }

    const formattedPhone = this.formatPhone(customerPhone);

    const existing = await this.prisma.ecommerceOrder.findUnique({
      where: { orgId_orderId: { orgId, orderId } },
    });
    await this.prisma.ecommerceOrder.upsert({
      where: { orgId_orderId: { orgId, orderId } },
      create: {
        orgId,
        orderId,
        customerPhone: formattedPhone,
        customerName,
        totalAmount,
        currency,
        checkoutToken,
        itemsSummary,
        paymentMethod: isCod ? 'COD' : 'PREPAID',
        orderStatus: 'OPEN',
        codStatus: isCod ? 'PENDING' : 'NOT_APPLICABLE',
      },
      update: { totalAmount, itemsSummary },
    });

    if (!isCod || !store.codConfirmationEnabled) {
      return { success: true, orderId, isCod, action: 'ORDER_LOGGED' };
    }
    // Shopify retries orders/create; ask the customer only once.
    if (existing?.confirmationSentAt) {
      return { success: true, orderId, isCod, action: 'ALREADY_SENT' };
    }

    const result = await this.sendCodConfirmation(store, {
      orderId,
      orderName,
      customerName,
      phone: formattedPhone,
      totalAmount,
    });
    await this.prisma.ecommerceOrder.update({
      where: { orgId_orderId: { orgId, orderId } },
      data: result.ok
        ? { confirmationSentAt: new Date(), confirmationError: null }
        : { confirmationError: result.error },
    });
    return result.ok
      ? {
          success: true,
          orderId,
          isCod,
          action: 'CONFIRMATION_SENT',
          via: result.via,
        }
      : { success: false, orderId, reason: result.error };
  }

  private async sendCodConfirmation(
    store: {
      orgId: string;
      codTemplateName: string | null;
      templateLanguage: string;
    },
    order: {
      orderId: string;
      orderName: string;
      customerName: string;
      phone: string;
      totalAmount: number;
    },
  ): Promise<{ ok: boolean; via?: 'TEMPLATE' | 'SESSION'; error?: string }> {
    const wa = await this.resolveWhatsAppChannel(store.orgId);
    if (!wa) {
      this.logger.warn(`No WhatsApp channel/token for org ${store.orgId}; skipping COD confirmation`);
      return { ok: false, error: 'NO_WHATSAPP_CHANNEL' };
    }

    const amount = `₹${order.totalAmount.toLocaleString('en-IN')}`;
    const confirmId = `COD_CONFIRM_${order.orderId}`;
    const cancelId = `COD_CANCEL_${order.orderId}`;

    if (store.codTemplateName) {
      // Expected template: body {{1}} name, {{2}} order number, {{3}} amount,
      // then two quick-reply buttons (Confirm, Cancel) in that order.
      const ok = await this.metaPublisher.sendWhatsAppTemplate(
        wa.phoneNumberId,
        order.phone,
        store.codTemplateName,
        store.templateLanguage,
        [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: order.customerName },
              { type: 'text', text: order.orderName },
              { type: 'text', text: amount },
            ],
          },
          {
            type: 'button',
            sub_type: 'quick_reply',
            index: '0',
            parameters: [{ type: 'payload', payload: confirmId }],
          },
          {
            type: 'button',
            sub_type: 'quick_reply',
            index: '1',
            parameters: [{ type: 'payload', payload: cancelId }],
          },
        ],
        wa.accessToken,
      );
      return ok ? { ok, via: 'TEMPLATE' } : { ok, error: 'TEMPLATE_SEND_FAILED' };
    }

    if (!(await this.hasOpenServiceWindow(store.orgId, order.phone))) {
      this.logger.warn(
        `No COD template configured for org ${store.orgId}; customer is outside the 24h window`,
      );
      return { ok: false, error: 'NO_TEMPLATE_CONFIGURED' };
    }

    const ok = await this.metaPublisher.sendInteractiveButtonMessage(
      wa.phoneNumberId,
      order.phone,
      'Order Verification Required',
      `Hi ${order.customerName}! Thank you for your order ${order.orderName} for ${amount}.\n\nTo ensure swift doorstep delivery and prevent accidental orders, please confirm your Cash on Delivery (COD) order below:`,
      'Tap below to verify in 1-click',
      [
        { id: confirmId, title: 'Confirm Order (COD)' },
        { id: cancelId, title: 'Cancel Order' },
      ],
      wa.accessToken,
    );
    return ok ? { ok, via: 'SESSION' } : { ok, error: 'SESSION_SEND_FAILED' };
  }

  private async markCartRecovered(orgId: string, checkoutToken: string | null, orderId: string) {
    if (!checkoutToken) return;
    await this.prisma.abandonedCart.updateMany({
      where: { orgId, cartToken: checkoutToken, recoveredAt: null },
      data: {
        // Only a cart we actually nudged counts as recovered; the rest just converted.
        recoveryStatus: 'COMPLETED',
        recoveredOrderId: orderId,
        recoveredAt: new Date(),
      },
    });
    await this.prisma.abandonedCart.updateMany({
      where: {
        orgId,
        cartToken: checkoutToken,
        recoveredOrderId: orderId,
        reminderStage: { gt: 0 },
      },
      data: { recoveryStatus: 'RECOVERED' },
    });
  }

  async handleCheckoutCreatedOrUpdated(checkoutPayload: any, shopDomain?: string) {
    const cartToken = String(checkoutPayload.token || checkoutPayload.id || '');
    const customerPhone =
      checkoutPayload.phone ||
      checkoutPayload.shipping_address?.phone ||
      checkoutPayload.customer?.phone ||
      '';
    const customerName = checkoutPayload.customer?.first_name || 'Shopper';
    const cartValue = parseFloat(checkoutPayload.total_price || '0');
    const checkoutUrl = checkoutPayload.abandoned_checkout_url || checkoutPayload.web_url || '';
    const isCompleted = !!checkoutPayload.completed_at;

    if (!cartToken || isCompleted) {
      if (cartToken && isCompleted) {
        const store = await this.resolveStore(shopDomain);
        if (store) {
          await this.prisma.abandonedCart.updateMany({
            where: {
              orgId: store.orgId,
              cartToken,
              recoveryStatus: { in: ['PENDING', 'EXHAUSTED'] },
            },
            data: { recoveryStatus: 'COMPLETED' },
          });
        }
      }
      return {
        success: false,
        reason: isCompleted ? 'ALREADY_COMPLETED' : 'MISSING_DATA',
      };
    }

    if (!customerPhone) {
      return { success: false, reason: 'MISSING_DATA' };
    }

    const store = await this.resolveStore(shopDomain);
    if (!store || !store.abandonedCartEnabled) {
      this.logger.warn(`No ShopifyStore (or cart recovery disabled) for ${shopDomain}`);
      return { success: false, reason: 'UNKNOWN_STORE' };
    }

    const formattedPhone = this.formatPhone(customerPhone);

    await this.prisma.abandonedCart
      .upsert({
        where: { orgId_cartToken: { orgId: store.orgId, cartToken } },
        create: {
          orgId: store.orgId,
          cartToken,
          customerPhone: formattedPhone,
          customerName,
          cartValue,
          currency: checkoutPayload.currency || 'INR',
          checkoutUrl,
          itemsSummary: this.summarizeItems(checkoutPayload.line_items),
          recoveryStatus: 'PENDING',
          reminderStage: 0,
        },
        update: {
          cartValue,
          checkoutUrl,
          customerPhone: formattedPhone,
          itemsSummary: this.summarizeItems(checkoutPayload.line_items),
        },
      })
      .catch((e) => this.logger.error(`Failed to upsert abandoned cart: ${e.message}`));

    this.logger.log(`Logged abandoned cart for ${customerName} (${formattedPhone}) - Value: ₹${cartValue}`);
    return { success: true, cartToken, action: 'CART_RECORDED' };
  }

  async processAbandonedCartReminders() {
    const now = Date.now();
    const pending = await this.prisma.abandonedCart.findMany({
      where: {
        recoveryStatus: 'PENDING',
        reminderStage: { lt: 3 },
        createdAt: { lte: new Date(now - STAGE1_MS) },
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });

    const stores = new Map<string, { enabled: boolean; templates: string[]; language: string } | null>();
    for (const cart of pending) {
      const age = now - cart.createdAt.getTime();
      let nextStage = 0;
      if (cart.reminderStage < 3 && age >= STAGE3_MS) nextStage = 3;
      else if (cart.reminderStage < 2 && age >= STAGE2_MS) nextStage = 2;
      else if (cart.reminderStage < 1 && age >= STAGE1_MS) nextStage = 1;

      if (!nextStage) continue;

      if (!stores.has(cart.orgId)) {
        const store = await this.prisma.shopifyStore.findFirst({
          where: { orgId: cart.orgId },
        });
        stores.set(
          cart.orgId,
          store
            ? {
                enabled: store.abandonedCartEnabled,
                templates: store.cartTemplateNames,
                language: store.templateLanguage,
              }
            : null,
        );
      }
      const store = stores.get(cart.orgId);
      if (!store?.enabled) continue;

      const wa = await this.resolveWhatsAppChannel(cart.orgId);
      if (!wa) {
        this.logger.warn(`Skipping cart ${cart.cartToken}: no WhatsApp channel`);
        continue;
      }

      const result = await this.sendCartReminder(cart, nextStage, store, wa.phoneNumberId, wa.accessToken);

      // A cart we cannot message (no template, send refused) still advances, otherwise
      // the scheduler would retry it every minute forever.
      await this.prisma.abandonedCart.update({
        where: { id: cart.id },
        data: {
          reminderStage: nextStage,
          lastReminderSentAt: result.ok ? new Date() : cart.lastReminderSentAt,
          lastReminderError: result.ok ? null : result.error,
          recoveryStatus: nextStage === 3 ? 'EXHAUSTED' : 'PENDING',
        },
      });
    }
  }

  private async sendCartReminder(
    cart: {
      orgId: string;
      customerName: string | null;
      customerPhone: string;
      cartValue: number;
      checkoutUrl: string;
    },
    stage: number,
    store: { templates: string[]; language: string },
    phoneNumberId: string,
    accessToken: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const name = cart.customerName || 'there';
    const value = `₹${cart.cartValue.toLocaleString('en-IN')}`;
    const code =
      stage === 2
        ? process.env.CART_DISCOUNT_STAGE2 || 'SAVE5'
        : process.env.CART_DISCOUNT_STAGE3 || 'SAVE10';
    const link = cart.checkoutUrl || '';

    const templateName = store.templates[stage - 1];
    if (templateName) {
      // Expected template body: stage 1 → {{1}} name, {{2}} cart value, {{3}} checkout link;
      // stages 2 and 3 → {{1}} name, {{2}} cart value, {{3}} discount code, {{4}} checkout link.
      const params = stage === 1 ? [name, value, link] : [name, value, code, link];
      const ok = await this.metaPublisher.sendWhatsAppTemplate(
        phoneNumberId,
        cart.customerPhone,
        templateName,
        store.language,
        [
          {
            type: 'body',
            parameters: params.map((text) => ({ type: 'text', text })),
          },
        ],
        accessToken,
      );
      return ok ? { ok } : { ok, error: 'TEMPLATE_SEND_FAILED' };
    }

    if (!(await this.hasOpenServiceWindow(cart.orgId, cart.customerPhone))) {
      return { ok: false, error: 'NO_TEMPLATE_CONFIGURED' };
    }

    let message: string;
    if (stage === 1) {
      message = `Hi ${name}, you left items in your cart (${value}). Complete checkout in one tap.`;
    } else if (stage === 2) {
      message = `Still thinking it over, ${name}? Use code ${code} for 5% off your cart of ${value}. Offer is time-limited.`;
    } else {
      message = `Last chance, ${name}: 10% off with code ${code} before your cart expires. Value: ${value}.`;
    }

    const ok = await this.metaPublisher.sendWhatsAppMessage(
      phoneNumberId,
      cart.customerPhone,
      message,
      accessToken,
      link || undefined,
    );
    return ok ? { ok } : { ok, error: 'SESSION_SEND_FAILED' };
  }

  async handleCodButtonCallback(
    buttonId: string,
    fromWaId: string,
    phoneNumberId: string,
    accessToken: string,
    orgId?: string,
  ) {
    this.logger.log(`Received COD button callback: buttonId=${buttonId} from ${fromWaId}`);

    const confirm = buttonId.startsWith('COD_CONFIRM_');
    if (!confirm && !buttonId.startsWith('COD_CANCEL_')) {
      return { success: false, reason: 'UNKNOWN_BUTTON_ID' };
    }
    const orderId = buttonId.replace(confirm ? 'COD_CONFIRM_' : 'COD_CANCEL_', '');
    const order = await this.prisma.ecommerceOrder.findFirst({
      where: { orderId, customerPhone: fromWaId, ...(orgId ? { orgId } : {}) },
    });
    if (!order) {
      this.logger.warn(`COD reply for unknown order ${orderId} from ${fromWaId}`);
      return { success: false, reason: 'UNKNOWN_ORDER' };
    }

    // A second tap (or a Meta retry) must not re-tag or cancel twice.
    if (order.codStatus === 'CONFIRMED' || order.codStatus === 'CANCELLED') {
      const text = `Order #${orderId} is already ${order.codStatus.toLowerCase()}. Reply here if you need help.`;
      await this.metaPublisher.sendWhatsAppMessage(phoneNumberId, fromWaId, text, accessToken);
      return {
        success: true,
        status: order.codStatus,
        orderId,
        action: 'ALREADY_HANDLED',
      };
    }

    if (confirm) {
      await this.prisma.ecommerceOrder.update({
        where: { id: order.id },
        data: { codStatus: 'CONFIRMED', confirmedAt: new Date() },
      });
      await this.tagShopifyOrder(order.orgId, orderId, 'COD-Confirmed');
      const confirmText = `Order #${orderId} Confirmed! We have queued your package for priority dispatch. You will receive tracking updates right here once it's on its way. Thank you!`;
      await this.metaPublisher.sendWhatsAppMessage(phoneNumberId, fromWaId, confirmText, accessToken);
      return { success: true, status: 'CONFIRMED', orderId };
    }

    await this.prisma.ecommerceOrder.update({
      where: { id: order.id },
      data: {
        codStatus: 'CANCELLED',
        orderStatus: 'CANCELLED',
        cancelledAt: new Date(),
      },
    });
    await this.tagShopifyOrder(order.orgId, orderId, 'COD-Cancelled');
    await this.cancelAndRestockShopifyOrder(order.orgId, orderId);
    const cancelText = `Order #${orderId} has been cancelled as requested. No charges will apply, and the item will not be shipped. Let us know if you change your mind!`;
    await this.metaPublisher.sendWhatsAppMessage(phoneNumberId, fromWaId, cancelText, accessToken);
    return { success: true, status: 'CANCELLED', orderId };
  }

  private async shopifyAdmin(orgId: string, orderId: string) {
    const store = await this.prisma.shopifyStore.findFirst({
      where: { orgId },
    });
    if (!store) return null;
    const token = this.decryptToken(store.accessTokenEncrypted);
    if (!token) return null;
    return { shopDomain: store.shopDomain, token, orderId };
  }

  private async tagShopifyOrder(orgId: string, orderId: string, tag: string) {
    const ctx = await this.shopifyAdmin(orgId, orderId);
    if (!ctx) {
      this.logger.warn(`Cannot tag Shopify order ${orderId}: missing store token`);
      return;
    }
    try {
      const getUrl = `https://${ctx.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/orders/${orderId}.json`;
      const existing = await fetch(getUrl, {
        headers: { 'X-Shopify-Access-Token': ctx.token },
      });
      if (!existing.ok) {
        this.logger.error(`Failed to fetch Shopify order ${orderId}: ${await existing.text()}`);
        return;
      }
      const data = await existing.json();
      const currentTags: string = data?.order?.tags || '';
      const tags = currentTags
        .split(',')
        .map((t: string) => t.trim())
        .filter(Boolean);
      if (!tags.includes(tag)) tags.push(tag);

      const putRes = await fetch(getUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': ctx.token,
        },
        body: JSON.stringify({
          order: { id: Number(orderId), tags: tags.join(', ') },
        }),
      });
      if (!putRes.ok) {
        this.logger.error(`Failed to tag Shopify order ${orderId}: ${await putRes.text()}`);
      }
    } catch (e: any) {
      this.logger.error(`tagShopifyOrder error: ${e.message}`);
    }
  }

  private async cancelAndRestockShopifyOrder(orgId: string, orderId: string) {
    const ctx = await this.shopifyAdmin(orgId, orderId);
    if (!ctx) {
      this.logger.warn(`Cannot cancel Shopify order ${orderId}: missing store token`);
      return;
    }
    try {
      const url = `https://${ctx.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/orders/${orderId}/cancel.json`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': ctx.token,
        },
        body: JSON.stringify({
          reason: 'customer',
          email: false,
          restock: true,
        }),
      });
      if (!res.ok) {
        this.logger.error(`Failed to cancel/restock Shopify order ${orderId}: ${await res.text()}`);
      }
    } catch (e: any) {
      this.logger.error(`cancelAndRestockShopifyOrder error: ${e.message}`);
    }
  }
}
