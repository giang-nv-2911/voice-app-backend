import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import oauth2 from '@fastify/oauth2';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import cors from '@fastify/cors';
import axios from 'axios';
import prisma from './lib/prisma.js';

const fastify: FastifyInstance = Fastify({
  logger: true,
});

// Extend Fastify types to include session user
declare module 'fastify' {
  interface Session {
    user?: {
      id: string;
      email: string;
      name: string;
      picture: string;
      [key: string]: any;
    };
    oauth_state?: string;
  }
}

// Register CORS
fastify.register(cors, {
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});

// Register Cookie and Session
fastify.register(cookie);
fastify.register(session, {
  secret: process.env.SESSION_SECRET || 'a-very-secret-key-at-least-32-characters-long',
  cookieName: 'voice_app_session',
  saveUninitialized: false,
  cookie: { 
    secure: false, 
    sameSite: 'lax',
    path: '/'
  }
});

// Register OAuth2
fastify.register(oauth2, {
  name: 'googleOAuth2',
  scope: ['profile', 'email'],
  generateStateFunction: (request: any, callback: any) => {
    const state = Math.random().toString(36).substring(2);
    request.session.oauth_state = state;
    callback(null, state);
  },
  checkStateFunction: (request: any, callback: any) => {
    const sessionState = request.session.oauth_state;
    const queryState = (request.query as any).state;
    
    if (sessionState && sessionState === queryState) {
      callback();
    } else {
      callback(new Error('Invalid state'));
    }
  },
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
  callbackUri: 'http://localhost:4000/api/auth/callback/google'
} as any);

// Routes
fastify.get('/api/auth/callback/google', async function (request, reply) {
  try {
    fastify.log.info('Handling Google OAuth callback...');
    
    // @ts-ignore
    const { token } = await this.googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(request);
    
    fastify.log.info('Token acquired successfully');
    
    // Get user info from Google
    const { data: googleUser } = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });

    // UPSERT User into Database
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

    fastify.log.info(`User authenticated and saved: ${user.email}`);

    // Save user to session
    request.session.user = {
      id: user.id,
      email: user.email,
      name: user.name || '',
      picture: user.picture || '',
    };

    // Redirect to frontend
    reply.redirect(process.env.FRONTEND_URL || 'http://localhost:3000');
  } catch (err: any) {
    fastify.log.error('OAuth Error Detail:');
    fastify.log.error(err);
    if (err.response) {
      fastify.log.error(err.response.data);
    }
    reply.status(500).send({ 
      error: 'Authentication failed', 
      message: err.message,
      detail: err.response?.data 
    });
  }
});

fastify.get('/api/me', async (request, reply) => {
  if (!request.session.user) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
  return request.session.user;
});

fastify.get('/logout', async (request, reply) => {
  request.session.destroy();
  reply.send({ success: true });
});

// DEBT APIs
fastify.get('/api/debts', async (request, reply) => {
  const user = request.session.user;
  if (!user) return reply.status(401).send({ error: 'Unauthorized' });

  const debts = await prisma.debt.findMany({
    where: { user_id: user.id },
    orderBy: { date: 'desc' },
  });
  return debts;
});

fastify.post('/api/debts', async (request, reply) => {
  const user = request.session.user;
  if (!user) return reply.status(401).send({ error: 'Unauthorized' });

  const { debtor_name, amount, description, date, type, transcript } = request.body as any;

  try {
    const debt = await prisma.debt.create({
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
    return debt;
  } catch (err: any) {
    fastify.log.error(err);
    return reply.status(500).send({ error: 'Failed to create debt record', message: err.message });
  }
});

fastify.patch('/api/debts/:id', async (request, reply) => {
  const user = request.session.user;
  if (!user) return reply.status(401).send({ error: 'Unauthorized' });

  const { id } = request.params as any;
  const { status } = request.body as any;

  try {
    const debt = await prisma.debt.update({
      where: { id: parseInt(id), user_id: user.id },
      data: { status },
    });
    return debt;
  } catch (err: any) {
    fastify.log.error(err);
    return reply.status(500).send({ error: 'Update failed' });
  }
});

fastify.delete('/api/debts/:id', async (request, reply) => {
  const user = request.session.user;
  if (!user) return reply.status(401).send({ error: 'Unauthorized' });

  const { id } = request.params as any;
  try {
    const debtId = parseInt(id);
    
    // 1. Transaction: Copy to DeletedDebt THEN Delete from Debt
    const result = await prisma.$transaction(async (tx) => {
      const debt = await tx.debt.findUnique({
        where: { id: debtId, user_id: user.id }
      });
      
      if (!debt) throw new Error('Debt not found');

      const archived = await tx.deletedDebt.create({
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

      await tx.debt.delete({
        where: { id: debtId }
      });

      return archived;
    });

    return { success: true, archived: result };
  } catch (err: any) {
    fastify.log.error(err);
    return reply.status(500).send({ error: 'Archive failed', message: err.message });
  }
});

fastify.get('/api/debts/trash', async (request, reply) => {
  const user = request.session.user;
  if (!user) return reply.status(401).send({ error: 'Unauthorized' });

  const deletedDebts = await prisma.deletedDebt.findMany({
    where: { user_id: user.id },
    orderBy: { deleted_at: 'desc' },
  });
  return deletedDebts;
});

fastify.post('/api/debts/trash/restore/:id', async (request, reply) => {
  const user = request.session.user;
  if (!user) return reply.status(401).send({ error: 'Unauthorized' });

  const { id } = request.params as any;
  try {
    const trashId = parseInt(id);
    
    const restored = await prisma.$transaction(async (tx) => {
      const deleted = await tx.deletedDebt.findUnique({
        where: { id: trashId, user_id: user.id }
      });
      
      if (!deleted) throw new Error('Deleted record not found');

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

      await tx.deletedDebt.delete({
        where: { id: trashId }
      });

      return restoredDebt;
    });

    return restored;
  } catch (err: any) {
    fastify.log.error(err);
    return reply.status(500).send({ error: 'Restore failed', message: err.message });
  }
});

fastify.get('/api/debts/stats', async (request, reply) => {
  const user = request.session.user;
  if (!user) return reply.status(401).send({ error: 'Unauthorized' });

  const stats = await prisma.debt.groupBy({
    by: ['type'],
    where: { user_id: user.id, status: 'pending' },
    _sum: { amount: true },
  });

  return stats;
});

fastify.delete('/api/debts/debtor/:name', async (request, reply) => {
  const user = request.session.user;
  if (!user) return reply.status(401).send({ error: 'Unauthorized' });

  const { name } = request.params as any;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const debts = await tx.debt.findMany({
        where: { user_id: user.id, debtor_name: name }
      });

      if (debts.length === 0) return { count: 0 };

      const archivedCount = await tx.deletedDebt.createMany({
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

      await tx.debt.deleteMany({
        where: { user_id: user.id, debtor_name: name }
      });

      return archivedCount;
    });

    return { success: true, ...result };
  } catch (err: any) {
    fastify.log.error(err);
    return reply.status(500).send({ error: 'Bulk archive failed', message: err.message });
  }
});

// Run the server
const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '4000');
    const host = process.env.HOST || '0.0.0.0';
    await fastify.listen({ port, host });
    console.log(`Server listening on ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
