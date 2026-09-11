import { hmacSha256Base64, hmacSha256Hex, parseFacebookSignedRequest, timingSafeEqualString } from './hmac';

describe('hmac helpers', () => {
  it('returns false instead of throwing when lengths differ', () => {
    expect(timingSafeEqualString('abc', 'abcd')).toBe(false);
  });

  it('accepts equal hex signatures', () => {
    const secret = 'app-secret';
    const payload = Buffer.from('{"ok":true}');
    const hex = hmacSha256Hex(secret, payload);
    expect(timingSafeEqualString(hex, hmacSha256Hex(secret, payload))).toBe(true);
  });

  it('computes Shopify-style base64 HMAC', () => {
    const digest = hmacSha256Base64('shop-secret', Buffer.from('{"id":1}'));
    expect(digest).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('parses a Meta signed_request', () => {
    const crypto = require('crypto') as typeof import('crypto');
    const payload = Buffer.from(JSON.stringify({ user_id: '99' }))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    const sig = crypto
      .createHmac('sha256', 'secret')
      .update(payload)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    const parsed = parseFacebookSignedRequest(`${sig}.${payload}`, 'secret');
    expect(parsed?.user_id).toBe('99');
  });
});
