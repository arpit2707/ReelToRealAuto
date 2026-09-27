/** The Reel2Real WhatsApp number that messages merchants (not a merchant channel). */
export type WaSender = { phoneNumberId: string; accessToken: string };

export function reel2realSender(): WaSender | null {
  const phoneNumberId = process.env.STORY_WA_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.STORY_WA_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  return phoneNumberId && accessToken ? { phoneNumberId, accessToken } : null;
}
