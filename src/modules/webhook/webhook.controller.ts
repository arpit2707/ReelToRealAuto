import { Controller, Get, Post, Query, Body, Headers, Res, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
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
    const result = this.webhookService.verifyWebhook(mode, token, challenge);
    if (result) {
      return res.status(HttpStatus.OK).send(result);
    }
    return res.status(HttpStatus.FORBIDDEN).send('Forbidden');
  }

  @Post()
  async handleWebhook(
    @Headers('x-hub-signature-256') signature: string,
    @Body() body: any,
    @Res() res: Response,
  ) {
    // Immediate 200 OK acknowledgment to Meta within 500ms
    res.status(HttpStatus.OK).json({ received: true });

    // Process event asynchronously
    setImmediate(async () => {
      try {
        await this.webhookService.processWebhookEvent(body);
      } catch (err) {
        console.error('Error processing webhook event asynchronously:', err);
      }
    });
  }

  @Post('simulate')
  async simulate(@Body() body: any) {
    return await this.webhookService.simulateInteraction(body);
  }
}
