import { Injectable, UnauthorizedException } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { loadConfig } from '../config/config';

export interface AccessTokenPayload {
  sub: string; // user id
  ten: string; // tenant id
  rol: string; // role name
}

@Injectable()
export class JwtTokenService {
  private readonly cfg = loadConfig();

  signAccess(payload: AccessTokenPayload): string {
    return jwt.sign(payload, this.cfg.JWT_ACCESS_SECRET, {
      expiresIn: this.cfg.ACCESS_TOKEN_TTL_SEC,
      issuer: 'gros',
    });
  }

  verifyAccess(token: string): AccessTokenPayload {
    try {
      const decoded = jwt.verify(token, this.cfg.JWT_ACCESS_SECRET, {
        issuer: 'gros',
      });
      if (typeof decoded === 'string') throw new Error('bad token');
      return decoded as unknown as AccessTokenPayload;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}
