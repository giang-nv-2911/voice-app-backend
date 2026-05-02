import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

// @ts-ignore - datasourceUrl is valid in Prisma v6 but types are incomplete
const prisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL,
});

export default prisma;
