/**
 * Vehicle fingerprint extractor.
 *
 * Given a set of photo URLs that should all show the SAME vehicle, run one cheap
 * vision call and return a structured identity fingerprint. Bytes are fetched
 * here and sent as base64 (never rely on the model downloading URLs, which fails
 * for private buckets / hotlink-protected hosts).
 */
const { complete } = require('../llm/claude');
const { CostTracker, estimateKes } = require('../llm/cost');
const logger = require('../../middlewheres/logger');

const FAST_MODEL = process.env.ANTHROPIC_MODEL_FAST || 'claude-haiku-4-5';
const ALLOWED_MEDIA = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_PHOTOS = 4; // cap photos per stage for cost/latency

// Bumped whenever the prompt/schema changes, so a stored verdict stays reproducible.
const FINGERPRINT_PROMPT_VERSION = 'vehicle-fingerprint@1';

const str = (v) => (typeof v === 'string' ? v.trim() : '');

const FINGERPRINT_TOOL = {
  name: 'report_vehicle',
  description: 'Report the identifying details of the vehicle visible across these photos.',
  input_schema: {
    type: 'object',
    properties: {
      vehicleVisible: { type: 'boolean', description: 'true if a motor vehicle is clearly visible in at least one photo' },
      plate: { type: 'string', description: 'number plate exactly as read, or empty string if not clearly legible' },
      plateConfidence: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
      make: { type: 'string' },
      model: { type: 'string' },
      colour: { type: 'string' },
      bodyStyle: { type: 'string', description: 'e.g. sedan, SUV, pickup, hatchback, lorry' },
      notableFeatures: { type: 'array', items: { type: 'string' }, description: 'permanent identifying marks: stickers, tint, rims, roof rack, pre-existing dents' },
      visibleDamage: { type: 'array', items: { type: 'string' }, description: 'damaged areas visible, e.g. "front-left bumper", "cracked windscreen"' },
    },
    required: ['vehicleVisible', 'plate', 'plateConfidence', 'make', 'model', 'colour', 'bodyStyle', 'notableFeatures', 'visibleDamage'],
  },
};

const SYSTEM = [
  'You are a motor-claims vehicle identification assistant.',
  'You are shown one or more photos that should all be of the SAME vehicle.',
  'Extract the vehicle’s identifying details as accurately as possible by calling report_vehicle.',
  'Read the number plate character by character ONLY if clearly legible; otherwise leave plate empty and set plateConfidence to "none". NEVER guess a plate.',
  'List permanent identifying features separately from claim-related visible damage. Do not infer anything you cannot actually see.',
].join('\n');

async function fetchImageSource(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'AVE-Insurance-Continuity/1.0', Accept: 'image/*' },
    });
    if (!res.ok) return null;
    const mimetype = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_MEDIA.includes(mimetype)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
    return { type: 'base64', media_type: mimetype, data: buf.toString('base64') };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract a vehicle fingerprint from a set of photo URLs.
 * @param {string[]} photos
 * @param {string}   label  human label for the stage (for the prompt)
 * @returns {Object|null} fingerprint (with _tokens/_kes spend), or null if no
 *   usable photo could be fetched or the vision call failed.
 */
async function extractFingerprint(photos, label = 'vehicle') {
  const urls = (Array.isArray(photos) ? photos : []).filter((u) => typeof u === 'string' && u).slice(0, MAX_PHOTOS);
  if (!urls.length) return null;

  const sources = [];
  for (const url of urls) {
    const s = await fetchImageSource(url); // sequential: keeps peak memory low
    if (s) sources.push(s);
  }
  if (!sources.length) return null;

  const cost = new CostTracker('vehicle-fingerprint');
  try {
    const resp = await complete({
      model: FAST_MODEL,
      system: SYSTEM,
      maxTokens: 512,
      tools: [FINGERPRINT_TOOL],
      toolChoice: { type: 'tool', name: 'report_vehicle' },
      messages: [{
        role: 'user',
        content: [
          ...sources.map((source) => ({ type: 'image', source })),
          { type: 'text', text: `These are the ${label} photos. Identify the vehicle.` },
        ],
      }],
    });
    cost.record(resp);
    cost.flush();

    const block = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'report_vehicle');
    const out = (block && block.input) || {};
    return {
      vehicleVisible: out.vehicleVisible === true,
      plate: str(out.plate),
      plateConfidence: ['high', 'medium', 'low', 'none'].includes(out.plateConfidence) ? out.plateConfidence : 'none',
      make: str(out.make),
      model: str(out.model),
      colour: str(out.colour),
      bodyStyle: str(out.bodyStyle),
      notableFeatures: Array.isArray(out.notableFeatures) ? out.notableFeatures.filter((x) => typeof x === 'string') : [],
      visibleDamage: Array.isArray(out.visibleDamage) ? out.visibleDamage.filter((x) => typeof x === 'string') : [],
      _tokens: cost.tokens,
      _kes: cost.kes,
    };
  } catch (err) {
    cost.flush();
    logger.warn(`[continuity] fingerprint extraction failed (${label}): ${err.message}`);
    return null;
  }
}

module.exports = { extractFingerprint, FINGERPRINT_PROMPT_VERSION, estimateKes };
