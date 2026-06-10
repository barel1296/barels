import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtTokenService } from './jwt.service';
import { AuthGuard } from './auth.guard';
import { RbacGuard } from '../rbac/rbac.guard';

@Global()
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtTokenService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RbacGuard },
  ],
  exports: [JwtTokenService],
})
export class AuthModule {}
