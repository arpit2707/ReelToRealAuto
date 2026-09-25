import { Module } from '@nestjs/common';
import { CryptoModule } from '../crypto/crypto.module';
import { MetaPublisherModule } from '../meta-publisher/meta-publisher.module';
import { RolesGuard } from '../auth/auth.guard';
import { StoriesController } from './stories.controller';
import { StoriesService } from './stories.service';
import { GeminiClient } from './gemini.client';
import { KeywordResearchService } from './keyword-research.service';

@Module({
  imports: [CryptoModule, MetaPublisherModule],
  controllers: [StoriesController],
  providers: [StoriesService, GeminiClient, KeywordResearchService, RolesGuard],
  exports: [StoriesService],
})
export class StoriesModule {}
