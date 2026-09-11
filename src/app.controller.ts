import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  async health(@Res() res: Response) {
    const result = await this.appService.getHealth();
    const status = result.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;
    return res.status(status).json(result);
  }
}
