import * as crypto from 'crypto';

export function timingSafeEqualString(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left);
  const rightBuf = Buffer.from(right);
  if (leftBuf.length !== rightBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuf, rightBuf);
}

export function hmacSha256Hex(secret: string, payload: Buffer | string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function hmacSha256Base64(secret: string, payload: Buffer | string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64');
}

/** Meta signed_request: HMAC-SHA256 of the payload, then base64url. */
export function parseFacebookSignedRequest(signedRequest: string, appSecret: string): Record<string, unknown> | null {
  const [encodedSig, payload] = signedRequest.split('.');
  if (!encodedSig || !payload) return null;
  const sig = Buffer.from(encodedSig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const expected = crypto.createHmac('sha256', appSecret).update(payload).digest();
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) {
    return null;
  }
  try {
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function rawBodyToBuffer(rawBody: Buffer | undefined): Buffer | null {
  if (!rawBody || rawBody.length === 0) {
    return null;
  }
  return rawBody;
}
