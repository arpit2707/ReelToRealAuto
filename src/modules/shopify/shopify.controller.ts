import { Controller, Post, Headers, Req, Res, HttpStatus, Logger } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ShopifyService } from './shopify.service';

@Controller('shopify/webhooks')
export class ShopifyController {
  private readonly logger = new Logger(ShopifyController.name);

  constructor(private readonly shopifyService: ShopifyService) {}

  @Post('orders/create')
  async handleOrderCreate(
    @Headers('x-shopify-hmac-sha256') hmac: string,
    @Headers('x-shopify-shop-domain') shopDomain: string,
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ) {
    return this.dispatch(hmac, shopDomain, req, res, (body) =>
      this.shopifyService.handleOrderCreated(body, shopDomain),
    );
  }

  @Post('checkouts/create')
  async handleCheckoutCreate(
    @Headers('x-shopify-hmac-sha256') hmac: string,
    @Headers('x-shopify-shop-domain') shopDomain: string,
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ) {
    return this.dispatch(hmac, shopDomain, req, res, (body) =>
      this.shopifyService.handleCheckoutCreatedOrUpdated(body, shopDomain),
    );
  }

  @Post('checkouts/update')
  async handleCheckoutUpdate(
    @Headers('x-shopify-hmac-sha256') hmac: string,
    @Headers('x-shopify-shop-domain') shopDomain: string,
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ) {
    return this.dispatch(hmac, shopDomain, req, res, (body) =>
      this.shopifyService.handleCheckoutCreatedOrUpdated(body, shopDomain),
    );
  }

  private async dispatch(
    hmac: string,
    shopDomain: string,
    req: RawBodyRequest<Request>,
    res: Response,
    handler: (body: any) => Promise<unknown>,
  ) {
    const valid = await this.shopifyService.verifyWebhookHmac(hmac, req.rawBody, shopDomain);
    if (!valid) {
      this.logger.warn(`Rejected Shopify webhook for shop=${shopDomain}: invalid HMAC`);
      return res.status(HttpStatus.UNAUTHORIZED).send('Invalid HMAC');
    }

    res.status(HttpStatus.OK).json({ received: true });

    setImmediate(async () => {
      try {
        await handler(req.body);
      } catch (err) {
        this.logger.error(`Error handling Shopify webhook: ${err}`);
      }
    });
  }
}
