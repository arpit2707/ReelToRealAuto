import { Module } from '@nestjs/common';
import { CryptoModule } from '../crypto/crypto.module';
import { RolesGuard } from '../auth/auth.guard';
import { AiProviderService } from './ai-provider.service';
import { AiSettingsController } from './ai-settings.controller';
import { LlmClient } from './llm.client';

@Module({
  imports: [CryptoModule],
  controllers: [AiSettingsController],
  providers: [AiProviderService, LlmClient, RolesGuard],
  exports: [AiProviderService, LlmClient],
})
export class AiProvidersModule {}
