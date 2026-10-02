import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  SetMetadata,
  Controller,
  Post,
  Body,
  Module,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { compare } from 'bcryptjs';
import { timingSafeEqual } from 'node:crypto';
import { ApiTags } from '@nestjs/swagger';
import { Db } from './db';
import { LoginDto } from '@opsflow/contracts';
export const Roles = (...roles: string[]) => SetMetadata('roles', roles);
export const Internal = () => SetMetadata('internal', true);
export const Public = () => SetMetadata('public', true);
function matches(a: string, b: string) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private jwt: JwtService,
    private reflector: Reflector,
    private db: Db,
  ) {}
  async canActivate(ctx: ExecutionContext) {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const req = ctx.switchToHttp().getRequest();
    if (this.reflector.getAllAndOverride('public', targets)) return true;
    if (this.reflector.getAllAndOverride('internal', targets)) {
      if (!matches(req.headers['x-workflow-token'] || '', process.env.WORKFLOW_TOKEN!))
        throw new UnauthorizedException('Invalid workflow authentication');
      return true;
    }
    try {
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      const payload = await this.jwt.verifyAsync(token);
      const user = await this.db.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, email: true, name: true, role: true },
      });
      if (!user) throw new Error();
      req.user = user;
    } catch {
      throw new UnauthorizedException('Sign in required');
    }
    const roles = this.reflector.getAllAndOverride<string[]>('roles', targets);
    if (roles && !roles.includes(req.user.role))
      throw new ForbiddenException('This action requires an authorized role');
    return true;
  }
}
@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(
    private db: Db,
    private jwt: JwtService,
  ) {}
  @Public() @Post('login') async login(@Body() dto: LoginDto) {
    const email = dto.email.toLowerCase();
    const now = Date.now();
    const old = this.attempts.get(email);
    if (old && old.until > now && old.count >= 10)
      throw new UnauthorizedException('Too many attempts; wait 15 minutes');
    const user = await this.db.user.findUnique({ where: { email } });
    if (!user || !(await compare(dto.password, user.passwordHash))) {
      this.attempts.set(email, {
        count: old && old.until > now ? old.count + 1 : 1,
        until: old && old.until > now ? old.until : now + 900000,
      });
      if (this.attempts.size > 10000) this.attempts.clear();
      throw new UnauthorizedException('Invalid email or password');
    }
    this.attempts.delete(email);
    return {
      accessToken: await this.jwt.signAsync({ sub: user.id }),
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    };
  }
}
@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '2h', issuer: 'opsflow', audience: 'opsflow-web' },
      verifyOptions: { issuer: 'opsflow', audience: 'opsflow-web' },
    }),
  ],
  controllers: [AuthController],
})
export class AuthModule {}
