const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const logger = require('./middlewheres/logger');
const { TokenIssuer } = require('./constants/encryption.constants');
const { effectiveOrigins } = require('./config/cors');
const { readPublicKey } = require('./config/keys');

let io;

const publicKey = readPublicKey();

// Extract a bearer token from the Socket.IO handshake (auth payload, Authorization header, or query).
const getHandshakeToken = (socket) => {
  const { token } = socket.handshake.auth || {};
  if (token) return token;
  const header = socket.handshake.headers?.authorization;
  if (header) return header.split(' ')[1];
  return socket.handshake.query?.token || null;
};

// Connection-level auth: reject sockets without a valid token, attach the decoded user.
const authenticateSocket = (socket, next) => {
  const token = getHandshakeToken(socket);
  if (!token) return next(new Error('Unauthorized: no token'));

  jwt.verify(token, publicKey.replace(/\\n/gm, '\n'), { issuer: TokenIssuer, algorithms: ['RS512'] }, (err, decoded) => {
    if (err) return next(new Error('Unauthorized: invalid token'));
    socket.user = decoded.payload;
    next();
  });
};

const init = (httpServer) => {
  // Socket.IO needs a literal '*' for allow-all; an array is matched by exact membership.
  const wildcard = effectiveOrigins.includes('*');
  io = socketIo(httpServer, {
    cors: {
      origin: wildcard ? '*' : effectiveOrigins,
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: !wildcard, // '*' + credentials is rejected by browsers
    },
  });

  io.use(authenticateSocket);

  io.on('connection', (socket) => {
    const userId = socket.user?.id;
    logger.info('Socket connected: %s (user %s)', socket.id, userId);

    // A user may only join their OWN notification room, regardless of the id they send.
    socket.on('join-room', (requestedId) => {
      if (userId) {
        if (requestedId && String(requestedId) !== String(userId)) {
          logger.warn('Socket %s (user %s) tried to join notification:%s — denied', socket.id, userId, requestedId);
          return;
        }
        socket.join(`notification:${userId}`);
        logger.info('Socket %s joined notification:%s', socket.id, userId);
      }
    });

    // Admin/fraud room is restricted to platform staff (ProviderUser tokens only).
    socket.on('join-admin', () => {
      if (socket.user?.accountType !== 'ProviderUser') {
        logger.warn('Socket %s (user %s) denied admin room — accountType=%s', socket.id, userId, socket.user?.accountType);
        return socket.emit('error', { message: 'Forbidden: admin access only' });
      }
      socket.join('admin');
      logger.info('Socket %s (user %s) joined admin room', socket.id, userId);
    });

    socket.on('disconnect', () => {
      logger.info('Socket disconnected: %s', socket.id);
    });
  });

  // Redis pub/sub bridge: worker process publishes, main app forwards to Socket.IO
  if (process.env.REDIS_URL) {
    const { Redis } = require('ioredis');
    const subscriber = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    subscriber.subscribe('claim:ai_updated').catch(err =>
      logger.warn(`[socket] Redis subscribe failed: ${err.message}`)
    );
    subscriber.on('message', (_channel, message) => {
      try {
        io.to('admin').emit('claim:ai_updated', JSON.parse(message));
      } catch {}
    });
    subscriber.on('error', err =>
      logger.warn(`[socket] Redis subscriber error: ${err.message}`)
    );
  }

  return io;
};

const getIO = () => {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
};

module.exports = { init, getIO };
