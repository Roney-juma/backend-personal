const https = require('https');
const logger = require('../middlewheres/logger');
const { getQueue } = require('../queue/queues');
require('dotenv').config();

const toE164 = (number) => {
  if (!number) return null;
  const stripped = number.replace(/[\s\-().]/g, '');
  if (stripped.startsWith('+')) return stripped;
  if (stripped.startsWith('0')) return `+254${stripped.slice(1)}`;
  return `+${stripped}`;
};

// Direct send — called by the worker (and as fallback when Redis is unavailable)
const sendWhatsAppDirect = async (to, message) => {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const baseUrl = process.env.WHATSAPP_API_URL;

  if (!token || !baseUrl) {
    logger.warn('WhatsApp not configured — WHATSAPP_ACCESS_TOKEN or WHATSAPP_API_URL missing');
    return;
  }

  const recipient = toE164(to);
  if (!recipient) return;

  const payload = JSON.stringify({
    messaging_product: 'whatsapp',
    to: recipient,
    type: 'text',
    text: { preview_url: false, body: message },
  });

  const endpoint = baseUrl.endsWith('/messages') ? baseUrl : `${baseUrl}/messages`;
  const url = new URL(endpoint);

  return new Promise((resolve) => {
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          logger.info(`WhatsApp sent | to=${recipient}`);
        } else {
          logger.error(`WhatsApp API error | to=${recipient} | status=${res.statusCode} | body=${body}`);
        }
        resolve();
      });
    });

    req.on('error', (err) => {
      logger.error(`WhatsApp request failed | to=${recipient} | ${err.message}`);
      resolve();
    });

    req.write(payload);
    req.end();
  });
};

// Enqueued send — all services call this; falls back to direct if Redis not available
const sendWhatsAppMessage = async (to, message) => {
  const queue = getQueue();
  if (queue) {
    await queue.add('whatsapp', { to, message });
  } else {
    await sendWhatsAppDirect(to, message);
  }
};

module.exports = { sendWhatsAppMessage, sendWhatsAppDirect };
