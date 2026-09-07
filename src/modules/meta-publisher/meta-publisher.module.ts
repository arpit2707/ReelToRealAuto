import { Module } from '@nestjs/common';
import { MetaPublisherService } from './meta-publisher.service';

@Module({
  providers: [MetaPublisherService],
  exports: [MetaPublisherService],
})
export class MetaPublisherModule {}
