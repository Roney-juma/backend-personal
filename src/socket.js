const socketIo = require('socket.io');

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
    console.log('Socket connected:', socket.id);

    // Client joins their personal room on connect
    socket.on('join-room', (userId) => {
      if (userId) {
        socket.join(`notification:${userId}`);
        console.log(`Socket ${socket.id} joined notification:${userId}`);
      }
    });

    socket.on('disconnect', () => {
      console.log('Socket disconnected:', socket.id);
    });
  });

  return io;
};

const getIO = () => {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
};

module.exports = { init, getIO };
