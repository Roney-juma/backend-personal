require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const { exec } = require("child_process");

const app = express();
const PORT = process.env.WEBHOOK_PORT || 4000;

const SECRET = process.env.WEBHOOK_SECRET;

if (!SECRET) {
  throw new Error("WEBHOOK_SECRET is not set — required to verify GitHub webhook signatures.");
}

// Branch → deploy script. Override the paths via env if your server dirs differ.
const DEPLOY_SCRIPTS = {
  production: process.env.DEPLOY_SCRIPT_PRODUCTION || "/home/ubuntu/deploy.sh",
  staging: process.env.DEPLOY_SCRIPT_STAGING || "/home/ubuntu/backend-staging/deploy-staging.sh",
};

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

  const sigBuf = Buffer.from(signature);
  const digestBuf = Buffer.from(digest);
  if (sigBuf.length !== digestBuf.length || !crypto.timingSafeEqual(sigBuf, digestBuf)) {
    return res.status(401).send("Invalid signature");
  }

  // Route by the pushed branch: staging push → staging deploy, production push → prod deploy.
  const branch = (req.body.ref || "").replace("refs/heads/", "");
  const script = DEPLOY_SCRIPTS[branch];

  if (!script) {
    console.log(`Webhook: ignoring push to '${branch || "unknown"}'`);
    return res.status(200).send(`Ignored branch: ${branch}`);
  }

  console.log(`Webhook verified — deploying '${branch}' via ${script}`);

  exec(`bash ${script}`, (error, stdout, stderr) => {
    if (error) {
      console.error(error);
      return res.status(500).send("Deployment failed");
    }

    console.log(stdout);

    if (stderr) {
      console.error(stderr);
    }

    res.status(200).send(`Deployment successful: ${branch}`);
  });
});

app.listen(PORT, () => {
  console.log(`Webhook running on port ${PORT}`);
});