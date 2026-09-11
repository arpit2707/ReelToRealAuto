import * as crypto from 'crypto';

export function graphVersion(): string {
  return process.env.META_GRAPH_VERSION || 'v24.0';
}

export function graphUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `https://graph.facebook.com/${graphVersion()}${p}`;
}

export function facebookDialogUrl(): string {
  return `https://www.facebook.com/${graphVersion()}/dialog/oauth`;
}

export function appsecretProof(accessToken: string, appSecret: string): string {
  return crypto.createHmac('sha256', appSecret).update(accessToken).digest('hex');
}
