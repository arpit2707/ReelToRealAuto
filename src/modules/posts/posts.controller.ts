import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { JwtPayload } from '../auth/jwt';
import { PostsService } from './posts.service';

@Controller('api/posts')
@UseGuards(JwtAuthGuard)
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload, @Query('channelId') channelId: string) {
    return this.posts.listPosts(user.orgId, channelId);
  }

  @Post('comments/:commentId/reply')
  reply(
    @CurrentUser() user: JwtPayload,
    @Param('commentId') commentId: string,
    @Body() body: { channelId: string; text: string },
  ) {
    return this.posts.replyToComment(
      user.orgId,
      body?.channelId,
      commentId,
      body?.text,
    );
  }
}
