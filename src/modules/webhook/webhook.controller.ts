import { Controller, Get, Post, Query, Body, Headers, Req, Res, HttpStatus } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { WebhookService } from './webhook.service';

@Controller('webhook')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    return this.verifyHandshake(mode, token, challenge, res);
  }

  @Get('meta')
  verifyMeta(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    return this.verifyHandshake(mode, token, challenge, res);
  }

  private verifyHandshake(mode: string, token: string, challenge: string, res: Response) {
    const result = this.webhookService.verifyWebhook(mode, token, challenge);
    if (result) {
      return res.status(HttpStatus.OK).send(result);
    }
    return res.status(HttpStatus.FORBIDDEN).send('Forbidden');
  }

  @Post()
  async handleWebhook(
    @Headers('x-hub-signature-256') signature: string,
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ) {
    return this.ack(signature, req, res);
  }

  @Post('meta')
  async handleMetaWebhook(
    @Headers('x-hub-signature-256') signature: string,
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ) {
    return this.ack(signature, req, res);
  }

  private ack(signature: string, req: RawBodyRequest<Request>, res: Response) {
    const rawBody = req.rawBody;
    if (!this.webhookService.verifySignature(signature, rawBody)) {
      return res.status(HttpStatus.FORBIDDEN).send('Invalid signature');
    }

    res.status(HttpStatus.OK).json({ received: true });

    setImmediate(async () => {
      try {
        await this.webhookService.processWebhookEvent(req.body, true);
      } catch (err) {
        console.error('Error processing webhook event asynchronously:', err);
      }
    });
  }

  @Post('simulate')
  async simulate(@Body() body: any, @Res() res: Response) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(HttpStatus.NOT_FOUND).send('Not Found');
    }
    const result = await this.webhookService.simulateInteraction(body);
    return res.status(HttpStatus.OK).json(result);
  }
}
