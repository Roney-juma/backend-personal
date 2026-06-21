const socketIo = require('socket.io');
const logger = require('./middlewheres/logger');

let io;

const init = (httpServer) => {
  io = socketIo(httpServer, {
    cors: {
      origin: ['*', 'https://admin.aveafricasolutions.com/'],
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

    socket.on('disconnect', () => {
      logger.info('Socket disconnected: %s', socket.id);
    });
  });

  return io;
};

const getIO = () => {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
};

module.exports = { init, getIO };
