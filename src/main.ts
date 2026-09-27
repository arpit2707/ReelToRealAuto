import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { allowedOrigins } from './common/origins';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableCors({ origin: allowedOrigins(), credentials: true });
  // Render (and most PaaS) require binding to 0.0.0.0, not just localhost.
  await app.listen(process.env.PORT ?? 5002, '0.0.0.0');
}
bootstrap();
