import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { CryptoModule } from './modules/crypto/crypto.module';
import { WebhookModule } from './modules/webhook/webhook.module';
import { AiClientModule } from './modules/ai-client/ai-client.module';
import { MetaPublisherModule } from './modules/meta-publisher/meta-publisher.module';
import { MetaOAuthModule } from './modules/meta-oauth/meta-oauth.module';
import { ShopifyModule } from './modules/shopify/shopify.module';

import { AuthModule } from './modules/auth/auth.module';
import { InboxModule } from './modules/inbox/inbox.module';

import { ConversationModule } from './modules/conversations/conversation.module';
import { ChannelConnectModule } from './modules/channels/channel-connect.module';
import { WorkspaceModule } from './modules/workspace/workspace.module';
import { StoriesModule } from './modules/stories/stories.module';
import { PostsModule } from './modules/posts/posts.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { AiProvidersModule } from './modules/ai-providers/ai-providers.module';
import { AdminModule } from './modules/admin/admin.module';

@Module({
  imports: [
    PrismaModule,
    RealtimeModule,
    CryptoModule,
    WebhookModule,
    AiClientModule,
    MetaPublisherModule,
    MetaOAuthModule,
    ShopifyModule,
    AuthModule,
    InboxModule,
    ConversationModule,
    ChannelConnectModule,
    WorkspaceModule,
    StoriesModule,
    PostsModule,
    CatalogModule,
    AiProvidersModule,
    AdminModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
