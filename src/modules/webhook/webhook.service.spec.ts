import { hmacSha256Hex } from '../../common/hmac';
import { WebhookService } from './webhook.service';

describe('WebhookService.verifySignature', () => {
  const makeService = () =>
    new WebhookService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

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
