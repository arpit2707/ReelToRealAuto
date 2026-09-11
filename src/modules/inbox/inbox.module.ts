import { Module } from '@nestjs/common';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { CryptoModule } from '../crypto/crypto.module';
import { MetaPublisherModule } from '../meta-publisher/meta-publisher.module';

import { ConversationModule } from '../conversations/conversation.module';

@Module({
  imports: [CryptoModule, MetaPublisherModule, ConversationModule],
  controllers: [InboxController],
  providers: [InboxService],
})
export class InboxModule {}
