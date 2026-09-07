import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WebhookModule } from './modules/webhook/webhook.module';
import { AiClientModule } from './modules/ai-client/ai-client.module';
import { MetaPublisherModule } from './modules/meta-publisher/meta-publisher.module';

@Module({
  imports: [WebhookModule, AiClientModule, MetaPublisherModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
