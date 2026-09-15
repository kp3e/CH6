import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

// WHY: global because nearly every feature module needs the database, and one
// PrismaService means one connection pool for the whole process.
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
