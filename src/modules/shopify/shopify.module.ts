import { Module } from '@nestjs/common';
import { ShopifyService } from './shopify.service';
import { ShopifyController } from './shopify.controller';
import { CommerceController } from './commerce.controller';
import { CommerceService } from './commerce.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { CryptoModule } from '../crypto/crypto.module';
import { MetaPublisherModule } from '../meta-publisher/meta-publisher.module';

@Module({
  imports: [PrismaModule, CryptoModule, MetaPublisherModule],
  controllers: [ShopifyController, CommerceController],
  providers: [ShopifyService, CommerceService],
  exports: [ShopifyService],
})
export class ShopifyModule {}
