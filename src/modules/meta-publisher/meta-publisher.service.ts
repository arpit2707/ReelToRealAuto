import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class MetaPublisherService {
  private readonly logger = new Logger(MetaPublisherService.name);

  async replyToComment(commentId: string, message: string, accessToken: string): Promise<boolean> {
    if (!accessToken || accessToken === 'mock_token') {
      this.logger.log(`[SIMULATION MODE] Would post reply to comment ${commentId}: "${message}"`);
      return true;
    }

    try {
      const url = `https://graph.facebook.com/v19.0/${commentId}/replies`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ message }),
      });

      if (!res.ok) {
        this.logger.error(`Failed to post comment reply: ${await res.text()}`);
        return false;
      }
      return true;
    } catch (err: any) {
      this.logger.error(`Error in replyToComment: ${err.message}`);
      return false;
    }
  }

  async sendPrivateDm(recipientId: string, message: string, accessToken: string): Promise<boolean> {
    if (!accessToken || accessToken === 'mock_token') {
      this.logger.log(`[SIMULATION MODE] Would send private DM to ${recipientId}: "${message}"`);
      return true;
    }

    try {
      const url = `https://graph.facebook.com/v19.0/me/messages`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: { text: message },
        }),
      });

      if (!res.ok) {
        this.logger.error(`Failed to send private DM: ${await res.text()}`);
        return false;
      }
      return true;
    } catch (err: any) {
      this.logger.error(`Error in sendPrivateDm: ${err.message}`);
      return false;
    }
  }

  async replyToFacebookComment(commentId: string, message: string, accessToken: string): Promise<boolean> {
    return this.replyToComment(commentId, message, accessToken);
  }

  async sendFacebookMessengerDm(pageId: string, recipientId: string, message: string, accessToken: string): Promise<boolean> {
    if (!accessToken || accessToken === 'mock_token' || accessToken.startsWith('mock_')) {
      this.logger.log(`[SIMULATION MODE] Would send Messenger DM to ${recipientId} from Page ${pageId}: "${message}"`);
      return true;
    }

    try {
      const url = `https://graph.facebook.com/v19.0/me/messages`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: { text: message },
        }),
      });

      if (!res.ok) {
        this.logger.error(`Failed to send Messenger DM: ${await res.text()}`);
        return false;
      }
      return true;
    } catch (err: any) {
      this.logger.error(`Error in sendFacebookMessengerDm: ${err.message}`);
      return false;
    }
  }

  async sendWhatsAppMessage(
    phoneNumberId: string,
    toWaId: string,
    message: string,
    accessToken: string,
    checkoutUrl?: string,
  ): Promise<boolean> {
    if (!accessToken || accessToken === 'mock_token' || accessToken.startsWith('mock_')) {
      this.logger.log(`[SIMULATION MODE] Would send WhatsApp message from PhoneID ${phoneNumberId} to ${toWaId}: "${message}" (Checkout: ${checkoutUrl || 'N/A'})`);
      return true;
    }

    try {
      const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;
      let bodyPayload: any;

      if (checkoutUrl) {
        bodyPayload = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: toWaId,
          type: 'interactive',
          interactive: {
            type: 'cta_url',
            header: { type: 'text', text: 'Order Confirmation' },
            body: { text: message },
            footer: { text: 'Reel2Real Instant Checkout' },
            action: {
              name: 'cta_url',
              parameters: {
                display_text: 'Buy Now (1-Click)',
                url: checkoutUrl,
              },
            },
          },
        };
      } else {
        bodyPayload = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: toWaId,
          type: 'text',
          text: { preview_url: true, body: message },
        };
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(bodyPayload),
      });

      if (!res.ok) {
        this.logger.error(`Failed to send WhatsApp message: ${await res.text()}`);
        return false;
      }
      return true;
    } catch (err: any) {
      this.logger.error(`Error in sendWhatsAppMessage: ${err.message}`);
      return false;
    }
  }
}

