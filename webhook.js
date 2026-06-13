const express = require("express");
const crypto = require("crypto");
const { exec } = require("child_process");

const app = express();
const PORT = 4000;

const SECRET = "avebackendservicesecret";

// Raw body parser for GitHub signature verification
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.post("/deploy", (req, res) => {
  const signature = req.headers["x-hub-signature-256"];

  if (!signature) {
    return res.status(401).send("No signature");
  }

  const hmac = crypto.createHmac("sha256", SECRET);
  const digest =
    "sha256=" + hmac.update(req.rawBody).digest("hex");

  if (
    !crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(digest)
    )
  ) {
    return res.status(401).send("Invalid signature");
  }

  console.log("Webhook verified");

  exec("bash /home/ubuntu/deploy.sh", (error, stdout, stderr) => {
    if (error) {
      console.error(error);
      return res.status(500).send("Deployment failed");
    }

    console.log(stdout);

    if (stderr) {
      console.error(stderr);
    }

    res.status(200).send("Deployment successful");
  });
});

app.listen(PORT, () => {
  console.log(`Webhook running on port ${PORT}`);
});