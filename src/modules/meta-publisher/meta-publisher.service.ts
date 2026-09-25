import { Injectable, Logger } from '@nestjs/common';
import { graphUrl } from '../../common/graph';

function metaErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body);
    return parsed?.error?.error_user_msg || parsed?.error?.message || body;
  } catch {
    return body;
  }
}

@Injectable()
export class MetaPublisherService {
  private readonly logger = new Logger(MetaPublisherService.name);

  // Instagram comment replies go to /{comment-id}/replies.
  async replyToComment(
    commentId: string,
    message: string,
    accessToken: string,
    failure?: { message?: string },
  ): Promise<boolean> {
    return this.postCommentReply(
      commentId,
      'replies',
      message,
      accessToken,
      failure,
    );
  }

  // Facebook has no /replies edge: a reply is a comment on the comment.
  async replyToFacebookComment(
    commentId: string,
    message: string,
    accessToken: string,
    failure?: { message?: string },
  ): Promise<boolean> {
    return this.postCommentReply(
      commentId,
      'comments',
      message,
      accessToken,
      failure,
    );
  }

  private async postCommentReply(
    commentId: string,
    edge: 'replies' | 'comments',
    message: string,
    accessToken: string,
    failure?: { message?: string },
  ): Promise<boolean> {
    if (
      !accessToken ||
      accessToken === 'mock_token' ||
      accessToken.startsWith('mock_')
    ) {
      this.logger.warn(
        `Refusing to post comment reply without a real access token`,
      );
      if (failure)
        failure.message =
          'This channel has no valid access token. Reconnect it.';
      return false;
    }

    try {
      const res = await fetch(graphUrl(`/${commentId}/${edge}`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ message }),
      });

      if (!res.ok) {
        const body = await res.text();
        this.logger.error(`Failed to post comment reply: ${body}`);
        if (failure) failure.message = metaErrorMessage(body);
        return false;
      }
      return true;
    } catch (err: any) {
      this.logger.error(`Error in postCommentReply: ${err.message}`);
      if (failure) failure.message = err.message;
      return false;
    }
  }

  // `failure`, when passed, receives Meta's reason so a caller can show it to the user.
  async sendPrivateDm(
    recipientId: string,
    message: string,
    accessToken: string,
    failure?: { message?: string },
  ): Promise<boolean> {
    if (
      !accessToken ||
      accessToken === 'mock_token' ||
      accessToken.startsWith('mock_')
    ) {
      this.logger.warn(
        `Refusing to send private DM without a real access token`,
      );
      if (failure)
        failure.message =
          'This channel has no valid access token. Reconnect it.';
      return false;
    }

    try {
      const url = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v24.0'}/me/messages`;
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
        const body = await res.text();
        this.logger.error(`Failed to send private DM: ${body}`);
        if (failure) failure.message = metaErrorMessage(body);
        return false;
      }
      return true;
    } catch (err: any) {
      this.logger.error(`Error in sendPrivateDm: ${err.message}`);
      if (failure) failure.message = err.message;
      return false;
    }
  }

  async sendFacebookMessengerDm(
    pageId: string,
    recipientId: string,
    message: string,
    accessToken: string,
    failure?: { message?: string },
  ): Promise<boolean> {
    if (
      !accessToken ||
      accessToken === 'mock_token' ||
      accessToken.startsWith('mock_')
    ) {
      this.logger.warn(
        `Refusing to send Messenger DM without a real access token`,
      );
      if (failure)
        failure.message =
          'This channel has no valid access token. Reconnect it.';
      return false;
    }

    try {
      const url = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v24.0'}/me/messages`;
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
        const body = await res.text();
        this.logger.error(`Failed to send Messenger DM: ${body}`);
        if (failure) failure.message = metaErrorMessage(body);
        return false;
      }
      return true;
    } catch (err: any) {
      this.logger.error(`Error in sendFacebookMessengerDm: ${err.message}`);
      if (failure) failure.message = err.message;
      return false;
    }
  }

  async sendWhatsAppMessage(
    phoneNumberId: string,
    toWaId: string,
    message: string,
    accessToken: string,
    checkoutUrl?: string,
    failure?: { message?: string },
  ): Promise<boolean> {
    if (
      !accessToken ||
      accessToken === 'mock_token' ||
      accessToken.startsWith('mock_')
    ) {
      this.logger.warn(
        `Refusing to send WhatsApp message without a real access token`,
      );
      if (failure)
        failure.message =
          'This channel has no valid access token. Reconnect it.';
      return false;
    }

    try {
      const url = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v24.0'}/${phoneNumberId}/messages`;
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
        const body = await res.text();
        this.logger.error(`Failed to send WhatsApp message: ${body}`);
        if (failure) failure.message = metaErrorMessage(body);
        return false;
      }
      return true;
    } catch (err: any) {
      this.logger.error(`Error in sendWhatsAppMessage: ${err.message}`);
      if (failure) failure.message = err.message;
      return false;
    }
  }

  async sendInteractiveButtonMessage(
    phoneNumberId: string,
    toWaId: string,
    headerText: string,
    bodyText: string,
    footerText: string,
    buttons: Array<{ id: string; title: string }>,
    accessToken: string,
  ): Promise<boolean> {
    if (!accessToken || accessToken === 'mock_token' || accessToken.startsWith('mock_')) {
      this.logger.warn(`Refusing to send interactive WhatsApp buttons without a real access token`);
      return false;
    }

    try {
      const url = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v24.0'}/${phoneNumberId}/messages`;
      const bodyPayload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toWaId,
        type: 'interactive',
        interactive: {
          type: 'button',
          header: { type: 'text', text: headerText },
          body: { text: bodyText },
          footer: { text: footerText },
          action: {
            buttons: buttons.map((b) => ({
              type: 'reply',
              reply: {
                id: b.id,
                title: b.title,
              },
            })),
          },
        },
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(bodyPayload),
      });

      if (!res.ok) {
        this.logger.error(`Failed to send WhatsApp button message: ${await res.text()}`);
        return false;
      }
      return true;
    } catch (err: any) {
      this.logger.error(`Error in sendInteractiveButtonMessage: ${err.message}`);
      return false;
    }
  }

  async sendWhatsAppTemplate(
    phoneNumberId: string,
    toWaId: string,
    templateName: string,
    languageCode: string = 'en_US',
    components: any[] = [],
    accessToken: string,
  ): Promise<boolean> {
    if (!accessToken || accessToken === 'mock_token' || accessToken.startsWith('mock_')) {
      this.logger.warn(`Refusing to send WhatsApp template without a real access token`);
      return false;
    }

    try {
      const url = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v24.0'}/${phoneNumberId}/messages`;
      const bodyPayload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toWaId,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components,
        },
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(bodyPayload),
      });

      if (!res.ok) {
        this.logger.error(`Failed to send WhatsApp template: ${await res.text()}`);
        return false;
      }
      return true;
    } catch (err: any) {
      this.logger.error(`Error in sendWhatsAppTemplate: ${err.message}`);
      return false;
    }
  }

  async sendWhatsAppImage(
    phoneNumberId: string,
    toWaId: string,
    imageUrl: string,
    caption: string,
    accessToken: string,
  ): Promise<boolean> {
    return this.postWhatsApp(phoneNumberId, accessToken, 'image', {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toWaId,
      type: 'image',
      image: { link: imageUrl, caption },
    });
  }

  /** Interactive list: up to 10 rows, unlike reply buttons which stop at 3. */
  async sendWhatsAppList(
    phoneNumberId: string,
    toWaId: string,
    bodyText: string,
    buttonText: string,
    rows: Array<{ id: string; title: string; description?: string }>,
    accessToken: string,
  ): Promise<boolean> {
    return this.postWhatsApp(phoneNumberId, accessToken, 'list', {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toWaId,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText },
        action: {
          button: buttonText.slice(0, 20),
          sections: [
            {
              title: 'Story options',
              rows: rows.map((r) => ({
                id: r.id,
                title: r.title.slice(0, 24),
                ...(r.description ? { description: r.description.slice(0, 72) } : {}),
              })),
            },
          ],
        },
      },
    });
  }

  private async postWhatsApp(phoneNumberId: string, accessToken: string, kind: string, body: unknown) {
    if (!accessToken || accessToken.startsWith('mock_')) {
      this.logger.warn(`Refusing to send WhatsApp ${kind} without a real access token`);
      return false;
    }
    try {
      const res = await fetch(graphUrl(`/${phoneNumberId}/messages`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        this.logger.error(`Failed to send WhatsApp ${kind}: ${await res.text()}`);
        return false;
      }
      return true;
    } catch (err: any) {
      this.logger.error(`Error sending WhatsApp ${kind}: ${err.message}`);
      return false;
    }
  }

  /**
   * Publishes a JPEG at a public URL as an Instagram story: create a STORIES
   * container, wait for Meta to fetch and process it, then publish. Throws with
   * Meta's error so the caller can tell the merchant what went wrong.
   */
  async publishInstagramStory(
    igUserId: string,
    imageUrl: string,
    accessToken: string,
    opts: { pollIntervalMs?: number; maxPolls?: number } = {},
  ): Promise<string> {
    const pollIntervalMs = opts.pollIntervalMs ?? 3000;
    const maxPolls = opts.maxPolls ?? 20;
    const auth = { Authorization: `Bearer ${accessToken}` };

    const createUrl = new URL(graphUrl(`/${igUserId}/media`));
    createUrl.searchParams.set('media_type', 'STORIES');
    createUrl.searchParams.set('image_url', imageUrl);
    const created = await this.graphJson(
      await fetch(createUrl, { method: 'POST', headers: auth }),
      'create story container',
    );
    const containerId = String(created.id);

    for (let i = 0; i < maxPolls; i++) {
      const statusUrl = new URL(graphUrl(`/${containerId}`));
      statusUrl.searchParams.set('fields', 'status_code,status');
      const status = await this.graphJson(await fetch(statusUrl, { headers: auth }), 'read container status');
      if (status.status_code === 'FINISHED') break;
      if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
        throw new Error(`Instagram rejected the story image: ${status.status || status.status_code}`);
      }
      if (i === maxPolls - 1) throw new Error('Instagram did not finish processing the story in time');
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    const publishUrl = new URL(graphUrl(`/${igUserId}/media_publish`));
    publishUrl.searchParams.set('creation_id', containerId);
    const published = await this.graphJson(await fetch(publishUrl, { method: 'POST', headers: auth }), 'publish story');
    return String(published.id);
  }

  private async graphJson(res: Response, step: string): Promise<any> {
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.error) {
      const message = json?.error?.error_user_msg || json?.error?.message || `HTTP ${res.status}`;
      throw new Error(`Instagram ${step} failed: ${message}`);
    }
    return json;
  }
}

