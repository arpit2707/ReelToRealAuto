import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { allowedOrigins } from './common/origins';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  // Room for a photo uploaded from the daily posts page (resized in the browser first).
  app.useBodyParser('json', { limit: '12mb' });
  app.enableCors({ origin: allowedOrigins(), credentials: true });
  // Render (and most PaaS) require binding to 0.0.0.0, not just localhost.
  await app.listen(process.env.PORT ?? 5002, '0.0.0.0');
}
bootstrap();
