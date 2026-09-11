import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';

export type JwtPayload = {
  sub: string;
  orgId: string;
  role: string;
  email: string;
};

function secret(): string {
  const value = process.env.JWT_SECRET;
  if (!value) {
    throw new Error('JWT_SECRET is required');
  }
  return value;
}

export function signAuthToken(payload: JwtPayload): string {
  return jwt.sign(payload, secret(), { expiresIn: '15m' });
}

export function signRefreshToken(payload: { sub: string }): string {
  return jwt.sign({ ...payload, typ: 'refresh' }, secret(), { expiresIn: '14d' });
}

export function verifyAuthToken(token: string): JwtPayload {
  return jwt.verify(token, secret()) as JwtPayload;
}

export function hashOpaqueToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
