import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard, RolesGuard } from './auth.guard';
import { ChannelConnectModule } from '../channels/channel-connect.module';

@Module({
  imports: [ChannelConnectModule],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, RolesGuard],
  exports: [AuthService, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
