import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { AiClientModule } from '../ai-client/ai-client.module';
import { MetaPublisherModule } from '../meta-publisher/meta-publisher.module';
import { CryptoModule } from '../crypto/crypto.module';

@Module({
  imports: [AiClientModule, MetaPublisherModule, CryptoModule],
  controllers: [WebhookController],
  providers: [WebhookService],
  exports: [WebhookService],
})
export class WebhookModule {}
