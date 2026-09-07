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
}
