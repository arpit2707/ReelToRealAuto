import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const frontend = process.env.FRONTEND_URL || 'http://localhost:3000';
  app.enableCors({ origin: [frontend, 'http://localhost:3000'], credentials: true });
  await app.listen(process.env.PORT ?? 5002);
}
bootstrap();
