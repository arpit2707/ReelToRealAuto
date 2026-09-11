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
      const store = await this.prisma.shopifyStore.findFirst({ where: { shopDomain } });
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
    return this.prisma.shopifyStore.findFirst({ where: { shopDomain }, include: { org: true } });
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
    const financialStatus = orderPayload.financial_status || '';
    const gateway = (orderPayload.gateway || orderPayload.payment_gateway_names?.[0] || '').toLowerCase();
    const isCod =
      gateway.includes('cod') || gateway.includes('cash_on_delivery') || financialStatus === 'pending';

    const customerPhone =
      orderPayload.customer?.phone ||
      orderPayload.shipping_address?.phone ||
      orderPayload.billing_address?.phone ||
      '';
    const customerName =
      orderPayload.customer?.first_name || orderPayload.shipping_address?.first_name || 'Customer';
    const totalAmount = parseFloat(orderPayload.total_price || '0');
    const currency = orderPayload.currency || 'INR';

    this.logger.log(`Shopify order created: #${orderId}, isCOD: ${isCod}, phone: ${customerPhone}`);

    if (!customerPhone) {
      this.logger.warn(`No phone number found for order #${orderId}. Skipping WhatsApp notification.`);
      return { success: false, reason: 'NO_PHONE' };
    }

    const store = await this.resolveStore(shopDomain);
    if (!store) {
      this.logger.warn(`No ShopifyStore for domain ${shopDomain}; skipping order ${orderId}`);
      return { success: false, reason: 'UNKNOWN_STORE' };
    }

    const formattedPhone = this.formatPhone(customerPhone);
    const orgId = store.orgId;

    await this.prisma.ecommerceOrder
      .upsert({
        where: { orgId_orderId: { orgId, orderId } },
        create: {
          orgId,
          orderId,
          customerPhone: formattedPhone,
          customerName,
          totalAmount,
          currency,
          paymentMethod: isCod ? 'COD' : 'PREPAID',
          orderStatus: 'OPEN',
          codStatus: isCod ? 'PENDING' : 'NOT_APPLICABLE',
        },
        update: {
          totalAmount,
          paymentMethod: isCod ? 'COD' : 'PREPAID',
        },
      })
      .catch((e) => this.logger.error(`Failed to upsert order in DB: ${e.message}`));

    if (!isCod || !store.codConfirmationEnabled) {
      return { success: true, orderId, isCod, action: 'ORDER_LOGGED' };
    }

    const wa = await this.resolveWhatsAppChannel(orgId);
    if (!wa) {
      this.logger.warn(`No WhatsApp channel/token for org ${orgId}; skipping COD confirmation`);
      return { success: false, reason: 'NO_WHATSAPP_CHANNEL' };
    }

    const headerText = 'Order Verification Required';
    const bodyText = `Hi ${customerName}! Thank you for your order #${orderId} for ₹${totalAmount.toLocaleString('en-IN')}.\n\nTo ensure swift doorstep delivery and prevent accidental orders, please confirm your Cash on Delivery (COD) order below:`;
    const footerText = 'Tap below to verify in 1-click';
    const buttons = [
      { id: `COD_CONFIRM_${orderId}`, title: 'Confirm Order (COD)' },
      { id: `COD_CANCEL_${orderId}`, title: 'Cancel Order' },
    ];

    await this.metaPublisher.sendInteractiveButtonMessage(
      wa.phoneNumberId,
      formattedPhone,
      headerText,
      bodyText,
      footerText,
      buttons,
      wa.accessToken,
    );

    return { success: true, orderId, isCod, action: 'CONFIRMATION_SENT' };
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
            where: { orgId: store.orgId, cartToken },
            data: { recoveryStatus: 'COMPLETED' },
          });
        }
      }
      return { success: false, reason: isCompleted ? 'ALREADY_COMPLETED' : 'MISSING_DATA' };
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
          checkoutUrl,
          recoveryStatus: 'PENDING',
          reminderStage: 0,
        },
        update: {
          cartValue,
          checkoutUrl,
          customerPhone: formattedPhone,
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
      },
      take: 50,
    });

    for (const cart of pending) {
      const age = now - cart.createdAt.getTime();
      let nextStage = 0;
      if (cart.reminderStage < 3 && age >= STAGE3_MS) nextStage = 3;
      else if (cart.reminderStage < 2 && age >= STAGE2_MS) nextStage = 2;
      else if (cart.reminderStage < 1 && age >= STAGE1_MS) nextStage = 1;

      if (!nextStage) continue;

      const wa = await this.resolveWhatsAppChannel(cart.orgId);
      if (!wa) {
        this.logger.warn(`Skipping cart ${cart.cartToken}: no WhatsApp channel`);
        continue;
      }

      const sent = await this.sendCartReminder(cart, nextStage, wa.phoneNumberId, wa.accessToken);
      if (!sent) continue;

      await this.prisma.abandonedCart.update({
        where: { id: cart.id },
        data: {
          reminderStage: nextStage,
          lastReminderSentAt: new Date(),
          recoveryStatus: nextStage === 3 ? 'EXHAUSTED' : 'PENDING',
        },
      });
    }
  }

  private async sendCartReminder(
    cart: {
      customerName: string | null;
      customerPhone: string;
      cartValue: number;
      checkoutUrl: string;
    },
    stage: number,
    phoneNumberId: string,
    accessToken: string,
  ): Promise<boolean> {
    const name = cart.customerName || 'there';
    const code2 = process.env.CART_DISCOUNT_STAGE2 || 'SAVE5';
    const code3 = process.env.CART_DISCOUNT_STAGE3 || 'SAVE10';
    let message: string;
    if (stage === 1) {
      message = `Hi ${name}, you left items in your cart (₹${cart.cartValue.toLocaleString('en-IN')}). Complete checkout in one tap.`;
    } else if (stage === 2) {
      message = `Still thinking it over, ${name}? Use code ${code2} for 5% off your cart of ₹${cart.cartValue.toLocaleString('en-IN')}. Offer is time-limited.`;
    } else {
      message = `Last chance, ${name}: 10% off with code ${code3} before your cart expires. Value: ₹${cart.cartValue.toLocaleString('en-IN')}.`;
    }

    return this.metaPublisher.sendWhatsAppMessage(
      phoneNumberId,
      cart.customerPhone,
      message,
      accessToken,
      cart.checkoutUrl || undefined,
    );
  }

  async handleCodButtonCallback(buttonId: string, fromWaId: string, phoneNumberId: string, accessToken: string) {
    this.logger.log(`Received COD button callback: buttonId=${buttonId} from ${fromWaId}`);

    if (buttonId.startsWith('COD_CONFIRM_')) {
      const orderId = buttonId.replace('COD_CONFIRM_', '');
      const order = await this.prisma.ecommerceOrder.findFirst({
        where: { orderId, customerPhone: fromWaId },
      });
      if (order) {
        await this.prisma.ecommerceOrder.updateMany({
          where: { orderId, customerPhone: fromWaId },
          data: { codStatus: 'CONFIRMED', confirmedAt: new Date() },
        });
        await this.tagShopifyOrder(order.orgId, orderId, 'COD-Confirmed');
      }

      const confirmText = `Order #${orderId} Confirmed! We have queued your package for priority dispatch. You will receive tracking updates right here once it's on its way. Thank you!`;
      await this.metaPublisher.sendWhatsAppMessage(phoneNumberId, fromWaId, confirmText, accessToken);
      return { success: true, status: 'CONFIRMED', orderId };
    }

    if (buttonId.startsWith('COD_CANCEL_')) {
      const orderId = buttonId.replace('COD_CANCEL_', '');
      const order = await this.prisma.ecommerceOrder.findFirst({
        where: { orderId, customerPhone: fromWaId },
      });
      if (order) {
        await this.prisma.ecommerceOrder.updateMany({
          where: { orderId, customerPhone: fromWaId },
          data: { codStatus: 'CANCELLED', orderStatus: 'CANCELLED' },
        });
        await this.tagShopifyOrder(order.orgId, orderId, 'COD-Cancelled');
        await this.cancelAndRestockShopifyOrder(order.orgId, orderId);
      }

      const cancelText = `Order #${orderId} has been cancelled as requested. No charges will apply, and the item will not be shipped. Let us know if you change your mind!`;
      await this.metaPublisher.sendWhatsAppMessage(phoneNumberId, fromWaId, cancelText, accessToken);
      return { success: true, status: 'CANCELLED', orderId };
    }

    return { success: false, reason: 'UNKNOWN_BUTTON_ID' };
  }

  private async shopifyAdmin(orgId: string, orderId: string) {
    const store = await this.prisma.shopifyStore.findFirst({ where: { orgId } });
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
        body: JSON.stringify({ order: { id: Number(orderId), tags: tags.join(', ') } }),
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
        body: JSON.stringify({ reason: 'customer', email: false, restock: true }),
      });
      if (!res.ok) {
        this.logger.error(`Failed to cancel/restock Shopify order ${orderId}: ${await res.text()}`);
      }
    } catch (e: any) {
      this.logger.error(`cancelAndRestockShopifyOrder error: ${e.message}`);
    }
  }
}
