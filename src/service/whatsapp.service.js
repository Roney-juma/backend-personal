const https = require('https');
const logger = require('../middlewheres/logger');
const { getQueue } = require('../queue/queues');
const { getCorrelationId } = require('../utils/requestContext');
require('dotenv').config();

const toE164 = (number) => {
  if (!number) return null;
  const stripped = number.replace(/[\s\-().]/g, '');
  if (stripped.startsWith('+')) return stripped;
  if (stripped.startsWith('0')) return `+254${stripped.slice(1)}`;
  return `+${stripped}`;
};

// WhatsApp template variables cannot contain newlines, tabs, or >4 consecutive
// spaces — Meta rejects the message otherwise. Our notification bodies are
// multi-line (`*title*\ncontent`), so collapse them into a single safe line
// before using them as a template parameter. Markdown-style *bold* is preserved
// (WhatsApp renders it).
const sanitizeParam = (text) =>
  String(text ?? '')
    .replace(/\s*\n\s*/g, ' — ')
    .replace(/\t/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();

// Build the Graph API request body. Three modes, in priority order:
//  1. An explicit template descriptor { name, params?, languageCode? }.
//  2. WHATSAPP_DEFAULT_TEMPLATE set — wrap the free-form `message` as the single
//     body variable of that approved template. This lets every existing caller
//     keep sending plain text while delivering OUTSIDE the 24h session window.
//  3. Neither — plain free-form text (only delivers inside the 24h window; handy
//     for local testing and replies).
const buildPayload = (recipient, message, template) => {
  const lang = process.env.WHATSAPP_TEMPLATE_LANG || 'en_US';
  const defaultTemplate = process.env.WHATSAPP_DEFAULT_TEMPLATE;

  const templateMessage = (name, params, languageCode) => ({
    messaging_product: 'whatsapp',
    to: recipient,
    type: 'template',
    template: {
      name,
      language: { code: languageCode || lang },
      ...(params && params.length
        ? { components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: sanitizeParam(p) })) }] }
        : {}),
    },
  });

  if (template && template.name) {
    return templateMessage(template.name, template.params, template.languageCode);
  }
  if (defaultTemplate) {
    return templateMessage(defaultTemplate, [message]);
  }
  return {
    messaging_product: 'whatsapp',
    to: recipient,
    type: 'text',
    text: { preview_url: false, body: message },
  };
};

// Direct send — called by the worker (and as fallback when Redis is unavailable).
// `template` (optional) is { name, params?, languageCode? } for callers that want
// a specific approved template instead of the default-wrap behaviour.
const sendWhatsAppDirect = async (to, message, template = null) => {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const baseUrl = process.env.WHATSAPP_API_URL;

  if (!token || !baseUrl) {
    logger.warn('WhatsApp not configured — WHATSAPP_ACCESS_TOKEN or WHATSAPP_API_URL missing');
    return;
  }

  const recipient = toE164(to);
  if (!recipient) return;

  const payload = JSON.stringify(buildPayload(recipient, message, template));

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
const sendWhatsAppMessage = async (to, message, template = null) => {
  const queue = getQueue();
  if (queue) {
    await queue.add('whatsapp', { to, message, template, correlationId: getCorrelationId() });
  } else {
    await sendWhatsAppDirect(to, message, template);
  }
};

module.exports = { sendWhatsAppMessage, sendWhatsAppDirect };
