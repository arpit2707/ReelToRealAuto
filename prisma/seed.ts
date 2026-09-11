import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as crypto from 'crypto';

function encrypt(plainText: string): string {
  const rawKey = process.env.ENCRYPTION_SECRET;
  if (!rawKey) {
    throw new Error('ENCRYPTION_SECRET is required to seed encrypted tokens');
  }
  const secretKey = crypto.createHash('sha256').update(rawKey).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey, iv);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  const org = await prisma.organization.upsert({
    where: { slug: 'default-org' },
    update: {},
    create: {
      id: 'org_default',
      name: 'Primary Merchant Org',
      slug: 'default-org',
    },
  });

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '1259818730556396';
  const waToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (waToken) {
    await prisma.channel.upsert({
      where: {
        platform_channelIdentifier: { platform: 'WHATSAPP', channelIdentifier: phoneNumberId },
      },
      update: {
        platform: 'WHATSAPP',
        name: 'WhatsApp Business',
        accessTokenEncrypted: encrypt(waToken),
        permissions: ['whatsapp_business_messaging', 'whatsapp_business_management'],
        isActive: true,
      },
      create: {
        orgId: org.id,
        platform: 'WHATSAPP',
        channelIdentifier: phoneNumberId,
        name: 'WhatsApp Business',
        accessTokenEncrypted: encrypt(waToken),
        permissions: ['whatsapp_business_messaging', 'whatsapp_business_management'],
        isActive: true,
      },
    });
    console.log(`Seeded WhatsApp channel ${phoneNumberId}`);
  } else {
    console.log('Skipped WhatsApp channel seed (WHATSAPP_ACCESS_TOKEN not set)');
  }

  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
  const shopToken = process.env.SHOPIFY_ACCESS_TOKEN;
  if (shopDomain && shopToken) {
    await prisma.shopifyStore.upsert({
      where: { orgId_shopDomain: { orgId: org.id, shopDomain } },
      update: {
        accessTokenEncrypted: encrypt(shopToken),
        webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_API_SECRET || undefined,
      },
      create: {
        orgId: org.id,
        shopDomain,
        accessTokenEncrypted: encrypt(shopToken),
        webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_API_SECRET || null,
      },
    });
    console.log(`Seeded Shopify store ${shopDomain}`);
  } else {
    console.log('Skipped Shopify store seed (SHOPIFY_SHOP_DOMAIN / SHOPIFY_ACCESS_TOKEN not set)');
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
