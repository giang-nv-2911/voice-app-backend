import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import oauth2 from '@fastify/oauth2';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import axios from 'axios';
import prisma from './lib/prisma.js';

const fastify: FastifyInstance = Fastify({
  logger: true,
  trustProxy: true,
});

// Extend Fastify types
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: any;
  }
}

// Register JWT
fastify.register(jwt, {
  secret: process.env.JWT_SECRET || 'your-extremely-secure-jwt-secret-key-change-it'
});

// Decorator for Auth
fastify.decorate("authenticate", async function(request: any, reply: any) {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.send(err);
  }
});

// Register CORS
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
fastify.register(cors, {
  origin: [frontendUrl, frontendUrl.replace(/\/$/, '')], // Chấp nhận cả có và không có dấu /
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'authorization'], // Chấp nhận cả chữ hoa và thường
  exposedHeaders: ['Authorization']
});

// Session is temporarily kept for internal OAuth state handling if needed
fastify.register(cookie);
fastify.register(session, {
  secret: process.env.SESSION_SECRET || 'a-very-secret-key-at-least-32-characters-long',
  cookieName: 'voice_app_oauth_session',
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    path: '/',
    maxAge: 10 * 60 * 1000, 
  }
});

// Register OAuth2
fastify.register(oauth2, {
  name: 'googleOAuth2',
  scope: ['profile', 'email'],
  credentials: {
    client: {
      id: process.env.GOOGLE_CLIENT_ID || '',
      secret: process.env.GOOGLE_CLIENT_SECRET || '',
    },
    auth: {
      authorizeHost: 'https://accounts.google.com',
      authorizePath: '/o/oauth2/v2/auth',
      tokenHost: 'https://www.googleapis.com',
      tokenPath: '/oauth2/v4/token'
    },
  },
  startRedirectPath: '/login/google',
  callbackUri: process.env.CALLBACK_URL || 'http://localhost:4000/api/auth/callback/google',
  generateStateFunction: (_request: any, callback: any) => {
    const state = Math.random().toString(36).substring(2);
    callback(null, state);
  },
  checkStateFunction: (_request: any, callback: any) => {
    callback();
  },
} as any);

// Routes
fastify.get('/api/auth/callback/google', async function (request, reply) {
  try {
    fastify.log.info('Handling Google OAuth callback...');
    
    // @ts-ignore
    const { token } = await this.googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(request);
    
    const { data: googleUser } = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });

    const user = await prisma.user.upsert({
      where: { id: googleUser.id },
      update: {
        name: googleUser.name,
        picture: googleUser.picture,
        email: googleUser.email,
      },
      create: {
        id: googleUser.id,
        email: googleUser.email,
        name: googleUser.name,
        picture: googleUser.picture,
      },
    });

    // Generate JWT Token
    const jwtToken = fastify.jwt.sign({
      id: user.id,
      email: user.email,
      name: user.name || '',
      picture: user.picture || '',
    }, {
      expiresIn: '30d' // Token hết hạn sau 30 ngày
    });

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    reply.redirect(`${frontendUrl}?token=${jwtToken}`);
  } catch (err: any) {
    fastify.log.error('OAuth Error:', err);
    reply.status(500).send({ 
       error: 'Authentication failed', 
       message: err.message,
       detail: err.response?.data
    });
  }
});

fastify.get('/api/me', { preHandler: [fastify.authenticate] }, async (request) => {
  return request.user;
});

// DEBT APIs
fastify.get('/api/debts/pending/:debtor', { preHandler: [fastify.authenticate] }, async (request) => {
  const user = request.user as any;
  const { debtor } = request.params as { debtor: string };

  const debts = await prisma.debt.findMany({
    where: {
      user_id: user.id,
      debtor_name: debtor,
      status: 'pending',
      type: 'lend' 
    },
    orderBy: { created_at: 'desc' }
  });

  return debts.map(d => ({
    id: d.id,
    nguoi_no: d.debtor_name,
    so_tien: Number(d.amount),
    noi_dung: d.description,
    ngay: d.date.toISOString().split('T')[0],
    loai: 'no'
  }));
});

fastify.post('/api/debts/repay', { preHandler: [fastify.authenticate] }, async (request, reply) => {
  const user = request.user as any;
  const { debtor_name, amount, transcript, date, description } = request.body as any;

  try {
    await prisma.debt.create({
      data: {
        user_id: user.id,
        debtor_name,
        amount: amount, 
        description: description || `Trả nợ ${amount.toLocaleString()}đ`,
        date: new Date(date),
        type: 'borrow',
        status: 'pending', 
        transcript: transcript ?? null
      }
    });
    return { success: true };
  } catch (err: any) {
    return reply.status(500).send({ error: 'Repayment failed' });
  }
});

fastify.get('/api/debts', { preHandler: [fastify.authenticate] }, async (request) => {
  const user = request.user as any;
  return await prisma.debt.findMany({
    where: { user_id: user.id },
    orderBy: { date: 'desc' },
  });
});

fastify.post('/api/debts', { preHandler: [fastify.authenticate] }, async (request, reply) => {
  const user = request.user as any;
  const { debtor_name, amount, description, date, type, transcript } = request.body as any;
  try {
    return await prisma.debt.create({
      data: {
        user_id: user.id,
        debtor_name,
        amount,
        description,
        date: new Date(date),
        type,
        transcript,
      },
    });
  } catch (err: any) {
    return reply.status(500).send({ error: 'Failed to create debt record' });
  }
});

fastify.patch('/api/debts/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
  const user = request.user as any;
  const { id } = request.params as any;
  const { status } = request.body as any;
  try {
    return await prisma.debt.update({
      where: { id: parseInt(id), user_id: user.id },
      data: { status },
    });
  } catch (err: any) {
    return reply.status(500).send({ error: 'Update failed' });
  }
});

fastify.delete('/api/debts/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
  const user = request.user as any;
  const { id } = request.params as any;
  try {
    const debtId = parseInt(id);
    return await prisma.$transaction(async (tx) => {
      const debt = await tx.debt.findUnique({ where: { id: debtId, user_id: user.id } });
      if (!debt) throw new Error('Debt not found');
      await tx.deletedDebt.create({
        data: {
          original_id: debt.id,
          user_id: debt.user_id,
          debtor_name: debt.debtor_name,
          amount: debt.amount,
          description: debt.description,
          date: debt.date,
          type: debt.type,
          status: debt.status,
          transcript: debt.transcript,
          created_at: debt.created_at,
        }
      });
      await tx.debt.delete({ where: { id: debtId } });
      return { success: true };
    });
  } catch (err: any) {
    return reply.status(500).send({ error: 'Archive failed' });
  }
});

fastify.get('/api/debts/trash', { preHandler: [fastify.authenticate] }, async (request) => {
  const user = request.user as any;
  return await prisma.deletedDebt.findMany({
    where: { user_id: user.id },
    orderBy: { deleted_at: 'desc' },
  });
});

fastify.post('/api/debts/trash/restore-bulk', { preHandler: [fastify.authenticate] }, async (request, reply) => {
  const user = request.user as any;
  const { ids } = request.body as { ids: number[] };
  try {
    const restored = await prisma.$transaction(async (tx) => {
      const restoredRecords = [];
      for (const id of ids) {
        const deleted = await tx.deletedDebt.findFirst({ where: { id, user_id: user.id } });
        if (!deleted) continue;
        const restoredDebt = await tx.debt.create({
          data: {
            user_id: deleted.user_id,
            debtor_name: deleted.debtor_name,
            amount: deleted.amount,
            description: deleted.description,
            date: deleted.date,
            type: deleted.type,
            status: deleted.status,
            transcript: deleted.transcript,
            created_at: deleted.created_at,
          }
        });
        await tx.deletedDebt.delete({ where: { id } });
        restoredRecords.push(restoredDebt);
      }
      return restoredRecords;
    });
    return { success: true, count: restored.length };
  } catch (err: any) {
    return reply.status(500).send({ error: 'Bulk restore failed' });
  }
});

fastify.delete('/api/debts/trash/bulk', { preHandler: [fastify.authenticate] }, async (request, reply) => {
  const user = request.user as any;
  const { ids } = request.body as { ids: number[] };
  try {
    const result = await prisma.deletedDebt.deleteMany({
      where: { id: { in: ids }, user_id: user.id }
    });
    return { success: true, count: result.count };
  } catch (err: any) {
    return reply.status(500).send({ error: 'Bulk delete failed' });
  }
});

fastify.get('/api/debts/stats', { preHandler: [fastify.authenticate] }, async (request) => {
  const user = request.user as any;
  return await prisma.debt.groupBy({
    by: ['type'],
    where: { user_id: user.id, status: 'pending' },
    _sum: { amount: true },
  });
});

fastify.delete('/api/debts/purge', { preHandler: [fastify.authenticate] }, async (request, reply) => {
  const user = request.user as any;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const debts = await tx.debt.findMany({ where: { user_id: user.id } });
      if (debts.length === 0) return { count: 0 };
      await tx.deletedDebt.createMany({
        data: debts.map(d => ({
          original_id: d.id,
          user_id: d.user_id,
          debtor_name: d.debtor_name,
          amount: d.amount,
          description: d.description,
          date: d.date,
          type: d.type,
          status: d.status,
          transcript: d.transcript,
          created_at: d.created_at,
        }))
      });
      return await tx.debt.deleteMany({ where: { user_id: user.id } });
    });
    return { success: true, ...result };
  } catch (err: any) {
    return reply.status(500).send({ error: 'Soft purge failed' });
  }
});

const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '4000');
    const host = process.env.HOST || '0.0.0.0';
    await fastify.listen({ port, host });
    console.log(`Server listening on ${port}`);
  } catch (err) {
    process.exit(1);
  }
};

start();
