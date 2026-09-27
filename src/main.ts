import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  // Room for a photo uploaded from the daily posts page (resized in the browser first).
  app.useBodyParser('json', { limit: '12mb' });
  const frontend = process.env.FRONTEND_URL || 'http://localhost:3000';
  const allowedOrigins = Array.from(
    new Set([
      frontend,
      'http://localhost:3000',
      'https://reel2realbooking.in',
      'https://www.reel2realbooking.in',
    ]),
  ).filter(Boolean);
  app.enableCors({ origin: allowedOrigins, credentials: true });
  // Render (and most PaaS) require binding to 0.0.0.0, not just localhost.
  await app.listen(process.env.PORT ?? 5002, '0.0.0.0');
}
bootstrap();
