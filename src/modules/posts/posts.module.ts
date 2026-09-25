import { Module } from '@nestjs/common';
import { CryptoModule } from '../crypto/crypto.module';
import { MetaPublisherModule } from '../meta-publisher/meta-publisher.module';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';

@Module({
  imports: [CryptoModule, MetaPublisherModule],
  controllers: [PostsController],
  providers: [PostsService],
})
export class PostsModule {}
