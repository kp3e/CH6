import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

// Intentionally public: load balancers use this endpoint for health checks.

@Controller('health')
export class HealthController {
  @Get()
  liveness() {
    return { status: 'ok' };
  }

  @Get('ready')
  readiness() {
    // checks the database, 503 if unreachable
    // TODO: real DB ping once prisma is up
    throw new ServiceUnavailableException('database check not implemented');
  }
}