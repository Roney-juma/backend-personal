const socketIo = require('socket.io');
const logger = require('./middlewheres/logger');

let io;

const init = (httpServer) => {
  io = socketIo(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    },
  });

  io.on('connection', (socket) => {
    logger.info('Socket connected: %s', socket.id);

    socket.on('join-room', (userId) => {
      if (userId) {
        socket.join(`notification:${userId}`);
        logger.info('Socket %s joined notification:%s', socket.id, userId);
      }
    });

    // Admin portal joins this room to receive real-time fraud/AI events
    socket.on('join-admin', () => {
      socket.join('admin');
      logger.info('Socket %s joined admin room', socket.id);
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
