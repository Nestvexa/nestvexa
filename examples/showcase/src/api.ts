import {
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { instance, mailMode, redis, s3 } from './config.js';
import { ShowcaseData } from './data.js';
import { Directory, SignedInGuard } from './identity.js';
import type { SessionRequest } from './identity.js';
import { SharedState } from './metrics.js';

/**
 * Native Nest REST endpoints next to the Nestvexa pages: ordinary controllers,
 * guards and pipes, untouched by Live or Inertia. Workspace-scoped: another
 * workspace's task id is a 404, not a 403, so ids are not an oracle.
 */
@Controller('api')
export class ApiController {
  constructor(
    @Inject(Directory) private readonly directory: Directory,
    @Inject(ShowcaseData) private readonly data: ShowcaseData,
    @Inject(SharedState) private readonly shared: SharedState,
  ) {}

  @Get('health')
  @Header('Cache-Control', 'no-store')
  health() {
    return {
      status: 'ok',
      instance,
      realtime: this.shared.distributed ? 'redis' : 'memory',
      storage: s3 ? 's3' : 'local',
      mail: mailMode,
      redis: redis !== undefined,
    };
  }

  @Get('tasks')
  @UseGuards(SignedInGuard)
  @Header('Cache-Control', 'no-store')
  list(@Req() request: SessionRequest) {
    const access = this.directory.require(request);
    return {
      workspace: access.workspace.slug,
      tasks: this.data
        .tasks(access.workspace.slug)
        .map(({ attachment, ...task }) => ({
          ...task,
          hasAttachment: attachment !== undefined,
        })),
    };
  }

  @Get('tasks/:id')
  @UseGuards(SignedInGuard)
  @Header('Cache-Control', 'no-store')
  one(@Req() request: SessionRequest, @Param('id') id: string) {
    const access = this.directory.require(request);
    const task = this.data.task(access.workspace.slug, String(id));
    if (!task) throw new NotFoundException();
    const { attachment, ...rest } = task;
    return { ...rest, hasAttachment: attachment !== undefined };
  }
}
