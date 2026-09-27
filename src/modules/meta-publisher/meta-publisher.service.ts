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
    return this.publishInstagramMedia(igUserId, { media_type: 'STORIES', image_url: imageUrl }, accessToken, 'story', opts);
  }

  /** Same container → poll → publish flow as a story, as a regular feed photo with a caption. */
  async publishInstagramFeed(
    igUserId: string,
    imageUrl: string,
    caption: string,
    accessToken: string,
    opts: { pollIntervalMs?: number; maxPolls?: number } = {},
  ): Promise<string> {
    return this.publishInstagramMedia(igUserId, { image_url: imageUrl, caption }, accessToken, 'post', opts);
  }

  /** Posts a photo with a message to a Facebook Page's feed. Needs pages_manage_posts. */
  async publishFacebookPhoto(pageId: string, imageUrl: string, message: string, pageToken: string): Promise<string> {
    const url = new URL(graphUrl(`/${pageId}/photos`));
    url.searchParams.set('url', imageUrl);
    url.searchParams.set('message', message);
    url.searchParams.set('published', 'true');
    const json = await this.graphJson(
      await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${pageToken}` } }),
      'photo post',
      'Facebook',
    );
    return String(json.post_id || json.id);
  }

  /**
   * Downloads a photo someone sent to our WhatsApp number: the media id gives a
   * short-lived URL, which also needs the token.
   */
  async downloadWhatsAppMedia(
    mediaId: string,
    accessToken: string,
    maxBytes = 16 * 1024 * 1024,
  ): Promise<{ data: Buffer; mimeType: string }> {
    const auth = { Authorization: `Bearer ${accessToken}` };
    const meta = await this.graphJson(
      await fetch(graphUrl(`/${mediaId}`), { headers: auth }),
      'media lookup',
      'WhatsApp',
    );
    if (!meta?.url) throw new Error('WhatsApp media lookup failed: no URL');
    const res = await fetch(String(meta.url), { headers: auth });
    if (!res.ok) throw new Error(`WhatsApp media download failed: HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > maxBytes) throw new Error('WhatsApp media is too large');
    return { data, mimeType: String(meta.mime_type || res.headers.get('content-type') || 'image/jpeg') };
  }

  /** An image with up to three reply buttons under it (only inside the 24h window). */
  async sendWhatsAppImageButtons(
    phoneNumberId: string,
    toWaId: string,
    imageUrl: string,
    bodyText: string,
    buttons: Array<{ id: string; title: string }>,
    accessToken: string,
  ): Promise<boolean> {
    return this.postWhatsApp(phoneNumberId, accessToken, 'image buttons', {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toWaId,
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'image', image: { link: imageUrl } },
        body: { text: bodyText.slice(0, 1024) },
        action: {
          buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })),
        },
      },
    });
  }

  private async publishInstagramMedia(
    igUserId: string,
    params: Record<string, string>,
    accessToken: string,
    kind: 'story' | 'post',
    opts: { pollIntervalMs?: number; maxPolls?: number },
  ): Promise<string> {
    const pollIntervalMs = opts.pollIntervalMs ?? 3000;
    const maxPolls = opts.maxPolls ?? 20;
    const auth = { Authorization: `Bearer ${accessToken}` };

    const createUrl = new URL(graphUrl(`/${igUserId}/media`));
    for (const [k, v] of Object.entries(params)) createUrl.searchParams.set(k, v);
    const created = await this.graphJson(
      await fetch(createUrl, { method: 'POST', headers: auth }),
      `create ${kind} container`,
    );
    const containerId = String(created.id);

    for (let i = 0; i < maxPolls; i++) {
      const statusUrl = new URL(graphUrl(`/${containerId}`));
      statusUrl.searchParams.set('fields', 'status_code,status');
      const status = await this.graphJson(await fetch(statusUrl, { headers: auth }), 'read container status');
      if (status.status_code === 'FINISHED') break;
      if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
        throw new Error(`Instagram rejected the ${kind} image: ${status.status || status.status_code}`);
      }
      if (i === maxPolls - 1) throw new Error(`Instagram did not finish processing the ${kind} in time`);
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    const publishUrl = new URL(graphUrl(`/${igUserId}/media_publish`));
    publishUrl.searchParams.set('creation_id', containerId);
    const published = await this.graphJson(
      await fetch(publishUrl, { method: 'POST', headers: auth }),
      `publish ${kind}`,
    );
    return String(published.id);
  }

  private async graphJson(res: Response, step: string, platform = 'Instagram'): Promise<any> {
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.error) {
      const message = json?.error?.error_user_msg || json?.error?.message || `HTTP ${res.status}`;
      throw new Error(`${platform} ${step} failed: ${message}`);
    }
    return json;
  }
}

