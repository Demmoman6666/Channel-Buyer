import { PrismaClient } from '@prisma/client';
import { env } from './env';

export const prisma = new PrismaClient();

export async function ensureDefaultUser() {
  const user = await prisma.user.upsert({
    where: { apiKey: env.API_KEY },
    update: {},
    create: { apiKey: env.API_KEY }
  });
  return user;
}
