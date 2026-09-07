import { Module } from '@nestjs/common';
import { MetaOAuthService } from './meta-oauth.service';
import { MetaOAuthController } from './meta-oauth.controller';
import { CryptoModule } from '../crypto/crypto.module';

@Module({
  imports: [CryptoModule],
  controllers: [MetaOAuthController],
  providers: [MetaOAuthService],
  exports: [MetaOAuthService],
})
export class MetaOAuthModule {}
