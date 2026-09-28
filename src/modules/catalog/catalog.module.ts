import { Module } from '@nestjs/common';
import { AiClientModule } from '../ai-client/ai-client.module';
import { CryptoModule } from '../crypto/crypto.module';
import { MetaPublisherModule } from '../meta-publisher/meta-publisher.module';
import { PostsModule } from '../posts/posts.module';
import { StoriesModule } from '../stories/stories.module';
import { RolesGuard } from '../auth/auth.guard';
import { CatalogController, LeadsController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { ReplyContextService } from './reply-context.service';
import { ReplyEngineService } from './reply-engine.service';
import { LeadsService } from './leads.service';
import { PostTaggingService } from './post-tagging.service';
import { PostAiGateService } from './post-ai-gate.service';

@Module({
  imports: [
    AiClientModule,
    CryptoModule,
    MetaPublisherModule,
    PostsModule,
    StoriesModule,
  ],
  controllers: [CatalogController, LeadsController],
  providers: [
    CatalogService,
    ReplyContextService,
    ReplyEngineService,
    LeadsService,
    PostTaggingService,
    PostAiGateService,
    RolesGuard,
  ],
  exports: [ReplyEngineService, CatalogService, PostTaggingService, PostAiGateService],
})
export class CatalogModule {}
