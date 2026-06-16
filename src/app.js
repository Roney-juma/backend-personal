require("dotenv").config();
const express = require("express");
const http = require("http");
const router = require("./routes/index");
const logger = require('./middlewheres/logger');
const mongoose = require("mongoose");
const cors = require("cors");
const socketModule = require('./socket');

const PORT = process.env.PORT || 3000;
mongoose.connect(process.env.MONGO_URI).then(() => {
  logger.info('Connected to MongoDB');
})
const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));
app.use("/", router);

app.get("/v1", (req, res) => {
  res.send("New phase of AVEAFRICA SOLUTIONS");
});

const server = http.createServer(app);
socketModule.init(server);

server.listen(PORT, (error) => {
  if (error) {
    console.log(error);
  } else {
    console.log(`Server running on port ${PORT}`);
  }
});

module.exports = app;
