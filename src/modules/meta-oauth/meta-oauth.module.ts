import { Module } from '@nestjs/common';
import { MetaOAuthService } from './meta-oauth.service';
import { MetaOAuthController } from './meta-oauth.controller';
import { CryptoModule } from '../crypto/crypto.module';
import { RolesGuard } from '../auth/auth.guard';

@Module({
  imports: [CryptoModule],
  controllers: [MetaOAuthController],
  providers: [MetaOAuthService, RolesGuard],
  exports: [MetaOAuthService],
})
export class MetaOAuthModule {}
