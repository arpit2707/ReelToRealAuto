import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { AiClientModule } from '../ai-client/ai-client.module';
import { MetaPublisherModule } from '../meta-publisher/meta-publisher.module';
import { CryptoModule } from '../crypto/crypto.module';
import { ShopifyModule } from '../shopify/shopify.module';

import { ConversationModule } from '../conversations/conversation.module';

@Module({
  imports: [AiClientModule, MetaPublisherModule, CryptoModule, ShopifyModule, ConversationModule],
  controllers: [WebhookController],
  providers: [WebhookService],
  exports: [WebhookService],
})
export class WebhookModule {}
