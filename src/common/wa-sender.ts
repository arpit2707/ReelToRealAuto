/** The Reel2Real WhatsApp number that messages merchants (not a merchant channel). */
export type WaSender = { phoneNumberId: string; accessToken: string };

// Set when the number is a WhatsApp channel connected in the dashboard, so only
// its (non-secret) phone number id has to be configured; see loadChannelSender.
let channelSender: WaSender | null = null;

export function reel2realSender(): WaSender | null {
  const phoneNumberId = process.env.STORY_WA_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.STORY_WA_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  if (phoneNumberId && accessToken) return { phoneNumberId, accessToken };
  return channelSender && channelSender.phoneNumberId === phoneNumberId ? channelSender : null;
}

export function setChannelSender(sender: WaSender | null) {
  channelSender = sender;
}
