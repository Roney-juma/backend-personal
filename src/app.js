const express = require("express");
const http = require("http");
const socketIo = require("socket.io"); 
const router = require("./routes/index");
const logger = require('./middlewheres/logger');
const mongoose = require("mongoose");
require("dotenv").config();
const cors = require("cors");

const PORT = process.env.PORT || 3306;
mongoose.connect(process.env.MONGO_URI).then(() => {
  logger.info('Connected to MongoDB');
})
const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));
app.use("/", router);
 
app.get("/v1", (req, res) => {
  res.send("Acha niseme initoke: Africa the Land We Love.");
});

// Create an HTTP server with the Express app
const server = http.createServer(app);

const io = socketIo(server, {
  cors: {
    origin: "*", // Allow all origins
    methods: ["GET", "POST"]
  }
});

// Socket.IO connection event
io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  // Example: Listen for a custom event from the client
  socket.on("custom-event", (data) => {
    console.log("Custom event received:", data);

    // Example: Emit an event back to the client
    socket.emit("response-event", { message: "Response from server" });
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log("A user disconnected:", socket.id);
  });
});

// Start the HTTP server instead of the Express app
server.listen(PORT, (error) => {
  if (error) {
    console.log(error);
  } else {
    console.log(`Server running on port ${PORT}`);
  }
});

module.exports = app;
