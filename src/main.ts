import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
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
