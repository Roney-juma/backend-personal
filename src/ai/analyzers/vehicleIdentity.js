/**
 * Vehicle fingerprint extractor.
 *
 * Given a set of photo URLs that should all show the SAME vehicle, run one cheap
 * vision call and return a structured identity fingerprint. Bytes are fetched
 * here and sent as base64 (never rely on the model downloading URLs, which fails
 * for private buckets / hotlink-protected hosts).
 */
const crypto = require('crypto');
const sharp = require('sharp');
const { complete } = require('../llm/claude');
const { CostTracker, estimateKes } = require('../llm/cost');
const logger = require('../../middlewheres/logger');

const FAST_MODEL = process.env.ANTHROPIC_MODEL_FAST || 'claude-haiku-4-5';
const ALLOWED_MEDIA = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_PHOTOS = 2; // cap photos per stage for cost/latency
// Vision token cost scales with pixel area (~w*h/750); 1024px long edge keeps a
// photo readable for make/colour/plate while costing ~1k tokens instead of ~1.6k.
const MAX_IMAGE_EDGE = 1024;
const MAX_UNRESIZED_BYTES = 2 * 1024 * 1024;

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
  'ALWAYS report make, model and colour as best you can from the photo — even when NO number plate is visible. Use the full manufacturer name (e.g. "Volkswagen", not "VW").',
  'Read the number plate character by character ONLY if clearly legible; otherwise leave plate empty and set plateConfidence to "none". NEVER guess a plate — a missing plate is fine, make/model/colour are what matter most.',
  'List permanent identifying features separately from claim-related visible damage. Do not infer anything you cannot actually see.',
].join('\n');

// Shrink an image so it costs fewer vision tokens. Falls back to the original
// bytes on any decode failure (corrupt file, unsupported variant).
async function downscale(buf, mimetype) {
  try {
    const img = sharp(buf, { failOn: 'none' });
    const meta = await img.metadata();
    const longEdge = Math.max(meta.width || 0, meta.height || 0);
    if (longEdge && longEdge <= MAX_IMAGE_EDGE && buf.length <= MAX_UNRESIZED_BYTES) {
      return { buf, mimetype };
    }
    const out = await img
      .rotate() // apply EXIF orientation before it's stripped by re-encoding
      .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return { buf: out, mimetype: 'image/jpeg' };
  } catch (_) {
    return { buf, mimetype };
  }
}

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
    const small = await downscale(buf, mimetype);
    return { type: 'base64', media_type: small.mimetype, data: small.buf.toString('base64') };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The photos a fingerprint call would actually send — shared with the cache key
// so the key changes whenever the effective photo set does.
const selectPhotos = (photos) =>
  (Array.isArray(photos) ? photos : []).filter((u) => typeof u === 'string' && u).slice(0, MAX_PHOTOS);

/**
 * Cache key for a stored fingerprint: changes when the prompt version, the
 * photo cap, or the effective photo set changes, so stale entries self-invalidate.
 */
const fingerprintCacheKey = (photos) =>
  crypto.createHash('sha256')
    .update([FINGERPRINT_PROMPT_VERSION, ...selectPhotos(photos)].join('\n'))
    .digest('hex');

/**
 * Extract a vehicle fingerprint from a set of photo URLs.
 * @param {string[]} photos
 * @param {string}   label  human label for the stage (for the prompt)
 * @param {Object}   [meta] usage attribution ({ claimId, customerId, stage })
 * @returns {Object|null} fingerprint (with _tokens/_kes spend), or null if no
 *   usable photo could be fetched or the vision call failed.
 */
async function extractFingerprint(photos, label = 'vehicle', meta = {}) {
  const urls = selectPhotos(photos);
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
      meta: { feature: 'vehicle-fingerprint', ...meta },
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

module.exports = { extractFingerprint, fingerprintCacheKey, FINGERPRINT_PROMPT_VERSION, estimateKes };
