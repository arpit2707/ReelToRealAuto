import { Module } from '@nestjs/common';
import { AiProvidersModule } from '../ai-providers/ai-providers.module';
import { SuperAdminGuard } from '../auth/superadmin';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [AiProvidersModule],
  controllers: [AdminController],
  providers: [AdminService, SuperAdminGuard],
})
export class AdminModule {}
