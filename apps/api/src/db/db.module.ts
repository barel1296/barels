import { Global, Module } from '@nestjs/common';
import { DbService } from './db.service';
import { ClickHouseService } from './clickhouse.service';

@Global()
@Module({
  providers: [DbService, ClickHouseService],
  exports: [DbService, ClickHouseService],
})
export class DbModule {}
