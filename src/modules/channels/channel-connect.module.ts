import { Module } from '@nestjs/common';
import { ChannelConnectService } from './channel-connect.service';
import { ChannelConnectController } from './channel-connect.controller';
import { MetaComplianceController } from '../meta-oauth/meta-compliance.controller';
import { CryptoModule } from '../crypto/crypto.module';
import { MetaOAuthModule } from '../meta-oauth/meta-oauth.module';
import { RolesGuard } from '../auth/auth.guard';

@Module({
  imports: [CryptoModule, MetaOAuthModule],
  controllers: [ChannelConnectController, MetaComplianceController],
  providers: [ChannelConnectService, RolesGuard],
  exports: [ChannelConnectService],
})
export class ChannelConnectModule {}
