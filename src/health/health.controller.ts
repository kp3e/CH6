import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service';

// Intentionally public: load balancers use this endpoint for health checks.

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  // WHY: liveness never touches the database. If it did, a database outage would
  // make the platform restart every instance — which cannot fix a database.
  @Get()
  liveness() {
    return { status: 'ok' };
  }

  @Get('ready')
  async readiness() {
    if (!(await this.health.isDatabaseReachable())) {
      // WHY: generic message — the reason (host, error code) goes to logs on
      // day 10, never to an unauthenticated caller.
      throw new ServiceUnavailableException('not ready');
    }
    return { status: 'ok' };
  }
}
