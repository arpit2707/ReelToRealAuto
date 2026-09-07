import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { AiClientModule } from '../ai-client/ai-client.module';
import { MetaPublisherModule } from '../meta-publisher/meta-publisher.module';

@Module({
  imports: [AiClientModule, MetaPublisherModule],
  controllers: [WebhookController],
  providers: [WebhookService],
  exports: [WebhookService],
})
export class WebhookModule {}
