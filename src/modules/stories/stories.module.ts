import { Module } from '@nestjs/common';
import { AiProvidersModule } from '../ai-providers/ai-providers.module';
import { CryptoModule } from '../crypto/crypto.module';
import { MetaPublisherModule } from '../meta-publisher/meta-publisher.module';
import { RolesGuard } from '../auth/auth.guard';
import { StoriesController } from './stories.controller';
import { StoriesService } from './stories.service';
import { GeminiClient } from './gemini.client';
import { KeywordResearchService } from './keyword-research.service';
import { MediaStore } from './media-store';

@Module({
  imports: [AiProvidersModule, CryptoModule, MetaPublisherModule],
  controllers: [StoriesController],
  providers: [
    StoriesService,
    GeminiClient,
    KeywordResearchService,
    MediaStore,
    RolesGuard,
  ],
  exports: [StoriesService, GeminiClient],
})
export class StoriesModule {}
