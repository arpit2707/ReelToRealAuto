import { Module } from '@nestjs/common';
import { ShopifyService } from './shopify.service';
import { ShopifyController } from './shopify.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { CryptoModule } from '../crypto/crypto.module';
import { MetaPublisherModule } from '../meta-publisher/meta-publisher.module';

@Module({
  imports: [PrismaModule, CryptoModule, MetaPublisherModule],
  controllers: [ShopifyController],
  providers: [ShopifyService],
  exports: [ShopifyService],
})
export class ShopifyModule {}
