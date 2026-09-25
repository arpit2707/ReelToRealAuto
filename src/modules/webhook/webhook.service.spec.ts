import { hmacSha256Hex } from '../../common/hmac';
import { WebhookService } from './webhook.service';

describe('WebhookService.verifySignature', () => {
  const makeService = () =>
    new WebhookService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

  afterEach(() => {
    delete process.env.META_APP_SECRET;
    delete process.env.META_VERIFY_TOKEN;
  });

  it('rejects when META_APP_SECRET is missing', () => {
    delete process.env.META_APP_SECRET;
    const service = makeService();
    expect(service.verifySignature('sha256=abc', Buffer.from('{}'))).toBe(false);
  });

  it('rejects mismatched length signatures without throwing', () => {
    process.env.META_APP_SECRET = 'secret';
    const service = makeService();
    expect(service.verifySignature('sha256=short', Buffer.from('{"a":1}'))).toBe(false);
  });

  it('accepts a valid HMAC of the raw body', () => {
    process.env.META_APP_SECRET = 'secret';
    const service = makeService();
    const raw = Buffer.from('{"object":"page"}');
    const sig = hmacSha256Hex('secret', raw);
    expect(service.verifySignature(`sha256=${sig}`, raw)).toBe(true);
  });
});

describe('WebhookService WhatsApp story routing', () => {
  it('hands story replies to the stories service before the channel lookup', async () => {
    const prisma: any = {
      webhookEvent: { create: jest.fn().mockResolvedValue({}) },
      processedWebhookEvent: { create: jest.fn().mockResolvedValue({}) },
      channel: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const stories: any = {
      isStoryReply: jest.fn((msg: any) => Boolean(msg.button)),
      handleWhatsAppReply: jest.fn().mockResolvedValue(undefined),
    };
    const service = new WebhookService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, stories);
    const storyMsg = { id: 'wamid.1', from: '919876543210', button: { payload: 'STORY_SHOW_b1' } };

    await service.processWebhookEvent({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'platform-phone' },
                messages: [storyMsg, { id: 'wamid.2', from: '1', text: { body: 'hi' } }],
              },
            },
          ],
        },
      ],
    });

    expect(stories.handleWhatsAppReply).toHaveBeenCalledWith(storyMsg);
    expect(stories.handleWhatsAppReply).toHaveBeenCalledTimes(1);
    // The ordinary message still goes through the normal path (channel lookup).
    expect(prisma.channel.findFirst).toHaveBeenCalled();
  });
});
