import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

describe('AuthService credentials', () => {
  const prisma: any = {
    user: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const auth = new AuthService(prisma);

  it('answers a missing email or password with 400, not a crash', async () => {
    for (const [email, password] of [
      [undefined, undefined],
      ['', 'x'],
      ['a@b.c', ''],
      [123, 'x'],
      ['a@b.c', { $ne: '' }],
    ] as any[]) {
      await expect(auth.login(email, password)).rejects.toThrow(
        BadRequestException,
      );
      await expect(auth.register(email, password)).rejects.toThrow(
        BadRequestException,
      );
    }
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('still says "Invalid email or password" for an unknown user', async () => {
    await expect(auth.login('nobody@x.com', 'secret')).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
