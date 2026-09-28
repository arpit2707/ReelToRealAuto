import { Module } from '@nestjs/common';
import { AiClientService } from './ai-client.service';
import { AiProvidersModule } from '../ai-providers/ai-providers.module';

@Module({
  imports: [AiProvidersModule],
  providers: [AiClientService],
  exports: [AiClientService],
})
export class AiClientModule {}
