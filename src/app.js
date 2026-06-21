require("dotenv").config();
const express = require("express");
const http = require("http");
const router = require("./routes/index");
const logger = require('./middlewheres/logger');
const httpLogger = require('./middlewheres/httpLogger');
const mongoose = require("mongoose");
const cors = require("cors");
const socketModule = require('./socket');

const PORT = process.env.PORT || 3000;

mongoose.connect(process.env.MONGO_URI)
  .then(() => logger.info('Connected to MongoDB'))
  .catch((err) => logger.error('MongoDB connection error:', err));

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));
app.use(httpLogger);
app.use("/", router);

app.get("/v1", (req, res) => {
  res.send("New phase of AVEAFRICA SOLUTIONS");
});

app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`, { stack: err.stack });
  res.status(500).json({ message: 'Internal server error' });
});

const server = http.createServer(app);
socketModule.init(server);

server.listen(PORT, (error) => {
  if (error) {
    logger.error('Server failed to start:', error);
  } else {
    logger.info(`Server running on port ${PORT}`);
  }
});

module.exports = app;
