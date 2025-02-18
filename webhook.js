const express = require('express');
const crypto = require('crypto');
const { exec } = require('child_process');

const app = express();
const PORT = 4000; // Use any available port
const SECRET = 'mysecrettoken'; // Replace with a secure secret key

// Middleware to parse JSON
app.use(express.json());

app.post('/deploy', (req, res) => {
    const signature = req.headers['x-hub-signature-256'];
    const hmac = crypto.createHmac('sha256', SECRET);
    const digest = 'sha256=' + hmac.update(JSON.stringify(req.body)).digest('hex');

    // if (signature !== digest) {
    //     return res.status(403).send('Unauthorized');
    // }

    // Execute deployment script
    exec('/deploy.sh', (error, stdout, stderr) => {
        if (error) {
            console.error(`Error: ${error.message}`);
            return res.status(500).send('Deployment failed');
        }
        if (stderr) {
            console.error(`Stderr: ${stderr}`);
            return res.status(500).send('Deployment error');
        }
        console.log(`Stdout: ${stdout}`);
        res.status(200).send('Deployed successfully');
    });
});

app.listen(PORT, () => {
    console.log(`Webhook listener running on port ${PORT}`);
});
