import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { CryptoModule } from './modules/crypto/crypto.module';
import { WebhookModule } from './modules/webhook/webhook.module';
import { AiClientModule } from './modules/ai-client/ai-client.module';
import { MetaPublisherModule } from './modules/meta-publisher/meta-publisher.module';
import { MetaOAuthModule } from './modules/meta-oauth/meta-oauth.module';

@Module({
  imports: [
    PrismaModule,
    CryptoModule,
    WebhookModule,
    AiClientModule,
    MetaPublisherModule,
    MetaOAuthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
