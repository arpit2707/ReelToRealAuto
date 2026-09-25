import { ShopifyService } from './shopify.service';

const STORE = {
  id: 'store-1',
  orgId: 'org-1',
  shopDomain: 'demo.myshopify.com',
  codConfirmationEnabled: true,
  abandonedCartEnabled: true,
  codTemplateName: 'cod_confirm' as string | null,
  cartTemplateNames: ['cart_1', 'cart_2', 'cart_3'],
  templateLanguage: 'en',
};

function makeService(overrides: { store?: Partial<typeof STORE>; order?: any; windowOpen?: boolean } = {}) {
  const store = { ...STORE, ...overrides.store };
  const prisma: any = {
    shopifyStore: { findFirst: jest.fn().mockResolvedValue(store) },
    channel: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ channelIdentifier: 'pnid', accessTokenEncrypted: 'enc', isActive: true }),
    },
    conversation: { findFirst: jest.fn().mockResolvedValue(overrides.windowOpen ? { id: 'c1' } : null) },
    ecommerceOrder: {
      findUnique: jest.fn().mockResolvedValue(overrides.order ?? null),
      findFirst: jest.fn().mockResolvedValue(overrides.order ?? null),
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
    abandonedCart: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const crypto: any = { decrypt: jest.fn().mockReturnValue('token') };
  const publisher: any = {
    sendWhatsAppTemplate: jest.fn().mockResolvedValue(true),
    sendInteractiveButtonMessage: jest.fn().mockResolvedValue(true),
    sendWhatsAppMessage: jest.fn().mockResolvedValue(true),
  };
  const service = new ShopifyService(prisma, crypto, publisher);
  // Stub the Shopify Admin calls; they are exercised against a real store, not here.
  (service as any).tagShopifyOrder = jest.fn();
  (service as any).cancelAndRestockShopifyOrder = jest.fn();
  return { service, prisma, publisher };
}

const codOrder = {
  id: 1001,
  name: '#1001',
  total_price: '1499.00',
  payment_gateway_names: ['Cash on Delivery (COD)'],
  checkout_token: 'chk_1',
  customer: { first_name: 'Asha', phone: '9876543210' },
  line_items: [{ title: 'Kurta', quantity: 2 }],
};

describe('ShopifyService.isCodOrder', () => {
  const { service } = makeService();
  it.each([
    [{ payment_gateway_names: ['Cash on Delivery (COD)'] }, true],
    [{ gateway: 'cash_on_delivery' }, true],
    [{ gateway: 'COD' }, true],
    [{ payment_gateway_names: ['razorpay'], financial_status: 'pending' }, false],
    [{ payment_gateway_names: ['bogus'] }, false],
  ])('%j → %s', (payload, expected) => {
    expect(service.isCodOrder(payload)).toBe(expected);
  });
});

describe('ShopifyService.handleOrderCreated', () => {
  it('sends the approved COD template with confirm/cancel payloads', async () => {
    const { service, publisher, prisma } = makeService();
    const res = await service.handleOrderCreated(codOrder, STORE.shopDomain);

    expect(res).toMatchObject({ success: true, action: 'CONFIRMATION_SENT', via: 'TEMPLATE' });
    const [pnid, to, name, lang, components] = publisher.sendWhatsAppTemplate.mock.calls[0];
    expect([pnid, to, name, lang]).toEqual(['pnid', '919876543210', 'cod_confirm', 'en']);
    expect(components[0].parameters.map((p: any) => p.text)).toEqual(['Asha', '#1001', '₹1,499']);
    expect(components[1].parameters[0].payload).toBe('COD_CONFIRM_1001');
    expect(components[2].parameters[0].payload).toBe('COD_CANCEL_1001');
    expect(prisma.ecommerceOrder.update.mock.calls[0][0].data.confirmationSentAt).toBeInstanceOf(Date);
  });

  it('does not send free-form text outside the 24h window when no template is set', async () => {
    const { service, publisher, prisma } = makeService({ store: { codTemplateName: null } });
    const res = await service.handleOrderCreated(codOrder, STORE.shopDomain);

    expect(res).toMatchObject({ success: false, reason: 'NO_TEMPLATE_CONFIGURED' });
    expect(publisher.sendInteractiveButtonMessage).not.toHaveBeenCalled();
    expect(prisma.ecommerceOrder.update.mock.calls[0][0].data.confirmationError).toBe('NO_TEMPLATE_CONFIGURED');
  });

  it('falls back to interactive buttons inside the 24h window', async () => {
    const { service, publisher } = makeService({ store: { codTemplateName: null }, windowOpen: true });
    const res = await service.handleOrderCreated(codOrder, STORE.shopDomain);
    expect(res).toMatchObject({ via: 'SESSION' });
    expect(publisher.sendInteractiveButtonMessage).toHaveBeenCalled();
  });

  it('asks only once when Shopify retries the webhook', async () => {
    const { service, publisher } = makeService({ order: { confirmationSentAt: new Date() } });
    const res = await service.handleOrderCreated(codOrder, STORE.shopDomain);
    expect(res).toMatchObject({ action: 'ALREADY_SENT' });
    expect(publisher.sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it('marks the matching abandoned cart as converted', async () => {
    const { service, prisma } = makeService();
    await service.handleOrderCreated(codOrder, STORE.shopDomain);
    expect(prisma.abandonedCart.updateMany.mock.calls[0][0].where).toMatchObject({
      orgId: 'org-1',
      cartToken: 'chk_1',
    });
    expect(prisma.abandonedCart.updateMany.mock.calls[1][0].data).toEqual({ recoveryStatus: 'RECOVERED' });
  });
});

describe('ShopifyService.handleCodButtonCallback', () => {
  it('confirms a pending order and tags it in Shopify', async () => {
    const order = { id: 'o1', orgId: 'org-1', orderId: '1001', codStatus: 'PENDING' };
    const { service, prisma } = makeService({ order });
    const res = await service.handleCodButtonCallback('COD_CONFIRM_1001', '919876543210', 'pnid', 't', 'org-1');
    expect(res).toMatchObject({ status: 'CONFIRMED' });
    expect(prisma.ecommerceOrder.update.mock.calls[0][0].data.codStatus).toBe('CONFIRMED');
    expect((service as any).tagShopifyOrder).toHaveBeenCalledWith('org-1', '1001', 'COD-Confirmed');
  });

  it('does not cancel twice when the customer taps again', async () => {
    const order = { id: 'o1', orgId: 'org-1', orderId: '1001', codStatus: 'CANCELLED' };
    const { service, prisma } = makeService({ order });
    const res = await service.handleCodButtonCallback('COD_CANCEL_1001', '919876543210', 'pnid', 't', 'org-1');
    expect(res).toMatchObject({ action: 'ALREADY_HANDLED' });
    expect(prisma.ecommerceOrder.update).not.toHaveBeenCalled();
    expect((service as any).cancelAndRestockShopifyOrder).not.toHaveBeenCalled();
  });
});

describe('ShopifyService.processAbandonedCartReminders', () => {
  const cart = (ageMs: number, stage = 0) => ({
    id: 'cart-1',
    orgId: 'org-1',
    cartToken: 'chk_1',
    customerName: 'Asha',
    customerPhone: '919876543210',
    cartValue: 2400,
    checkoutUrl: 'https://demo.myshopify.com/checkouts/chk_1',
    reminderStage: stage,
    lastReminderSentAt: null,
    createdAt: new Date(Date.now() - ageMs),
  });

  it('sends the stage-2 template with the discount code after 6 hours', async () => {
    const { service, prisma, publisher } = makeService();
    prisma.abandonedCart.findMany.mockResolvedValue([cart(7 * 3600_000, 1)]);
    await service.processAbandonedCartReminders();

    const [, , name, , components] = publisher.sendWhatsAppTemplate.mock.calls[0];
    expect(name).toBe('cart_2');
    expect(components[0].parameters.map((p: any) => p.text)).toEqual([
      'Asha',
      '₹2,400',
      'SAVE5',
      'https://demo.myshopify.com/checkouts/chk_1',
    ]);
    expect(prisma.abandonedCart.update.mock.calls[0][0].data).toMatchObject({
      reminderStage: 2,
      recoveryStatus: 'PENDING',
      lastReminderError: null,
    });
  });

  it('records why a reminder could not go out and moves on', async () => {
    const { service, prisma, publisher } = makeService({ store: { cartTemplateNames: [] } });
    prisma.abandonedCart.findMany.mockResolvedValue([cart(20 * 60_000)]);
    await service.processAbandonedCartReminders();

    expect(publisher.sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(prisma.abandonedCart.update.mock.calls[0][0].data).toMatchObject({
      reminderStage: 1,
      lastReminderError: 'NO_TEMPLATE_CONFIGURED',
    });
  });

  it('skips stores that turned cart recovery off', async () => {
    const { service, prisma, publisher } = makeService({ store: { abandonedCartEnabled: false } });
    prisma.abandonedCart.findMany.mockResolvedValue([cart(20 * 60_000)]);
    await service.processAbandonedCartReminders();
    expect(publisher.sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(prisma.abandonedCart.update).not.toHaveBeenCalled();
  });
});
