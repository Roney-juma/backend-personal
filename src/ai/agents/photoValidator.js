/**
 * Pre-upload photo gate.
 *
 * Runs a single cheap vision call to decide whether an uploaded image is
 * actually relevant to a motor claim (a vehicle, damage, an accident scene, or
 * a supporting document like a driving licence / insurance sticker) rather than
 * a random/irrelevant photo. The intake page calls this BEFORE putting the file
 * in S3, so junk never reaches storage.
 */
const { complete } = require('../llm/claude');
const { CostTracker } = require('../llm/cost');
const logger = require('../../middlewheres/logger');
const { FEATURES } = require('../features');

// Optional EXIF reader — used for the photo-recency gate. Installed separately
// (npm i exifr). If it's missing we fail OPEN on the age check (see checkPhotoAge).
let exifr = null;
try { exifr = require('exifr'); } catch (_) {}

// Fast, cheap model for a yes/no-style classification.
const FAST_MODEL = process.env.ANTHROPIC_MODEL_FAST || 'claude-haiku-4-5';

// Recency gate: reject photos taken more than this many days before upload.
const MAX_PHOTO_AGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PHOTO_AGE_MS = MAX_PHOTO_AGE_DAYS * DAY_MS;

const ALLOWED_MEDIA = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const CATEGORIES = [
  'vehicle',          // a car/vehicle, no obvious damage
  'vehicle_damage',   // damage to a vehicle
  'accident_scene',   // wider scene of an accident
  'driving_licence',  // a driver's licence document
  'insurance_sticker',// insurance sticker/disc/certificate
  'other_document',   // other claim-relevant document (police report, estimate…)
  'irrelevant',       // anything else — reject
];

const CHECK_TOOL = {
  name: 'report_photo_check',
  description: 'Report whether the image is relevant to a motor-insurance claim.',
  input_schema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: CATEGORIES },
      relevant: {
        type: 'boolean',
        description: 'true if the image is a vehicle, vehicle damage, an accident scene, or a claim-related document',
      },
      quality: {
        type: 'string',
        enum: ['good', 'poor'],
        description: 'poor if blurry, too dark, or the key detail is unreadable',
      },
      reason: { type: 'string', description: 'one short sentence the claimant can read' },
    },
    required: ['category', 'relevant', 'quality', 'reason'],
  },
};

const SYSTEM = [
  'You are a strict image gate for a motor-insurance claim app.',
  'Decide if the supplied photo is one of: a vehicle, vehicle damage, an accident scene,',
  'a driving licence, an insurance sticker/disc, or another claim-related document.',
  'Anything else (selfies, food, screenshots, memes, random objects, blank images) is NOT relevant.',
  'Always answer by calling the report_photo_check tool. Be conservative: if it is clearly not',
  'claim-related, set relevant=false.',
].join('\n');

/**
 * Classify an in-memory image.
 * @param {Buffer} buffer     Raw image bytes.
 * @param {string} mimetype   e.g. 'image/jpeg'.
 * @returns {Object} { valid, category, quality, reason }
 */
/** Run the classification against a prepared Anthropic image source block. */
async function classify(imageSource, meta = {}) {
  const cost = new CostTracker('photo-validate');
  try {
    const response = await complete({
      model: FAST_MODEL,
      system: SYSTEM,
      maxTokens: 256,
      tools: [CHECK_TOOL],
      toolChoice: { type: 'tool', name: 'report_photo_check' },
      meta: { feature: FEATURES.PHOTO_VALIDATE, stage: 'intake', ...meta },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: imageSource },
            { type: 'text', text: 'Is this photo relevant to a motor-insurance claim?' },
          ],
        },
      ],
    });
    cost.record(response);
    cost.flush();

    const block = (response.content || []).find((b) => b.type === 'tool_use' && b.name === 'report_photo_check');
    const out = (block && block.input) || {};
    return {
      valid: out.relevant === true,
      category: CATEGORIES.includes(out.category) ? out.category : 'irrelevant',
      quality: out.quality === 'poor' ? 'poor' : 'good',
      reason: typeof out.reason === 'string' && out.reason ? out.reason : 'Could not verify the photo.',
    };
  } catch (err) {
    cost.flush();
    logger.error(`[ai] photo validation failed: ${err.message}`);
    // Fail OPEN so a vision outage never blocks a genuine claim; the intake
    // agent still sees the image and can flag obvious problems.
    return { valid: true, category: 'other_document', quality: 'good', reason: 'Validation unavailable — allowed.' };
  }
}

/**
 * Read the capture date from an image's EXIF metadata and decide whether the
 * photo is older than MAX_PHOTO_AGE_DAYS relative to now.
 *
 * Fails OPEN (returns { tooOld: false }) whenever we cannot establish an age:
 * the exifr package is missing, EXIF is unreadable, or there is no capture
 * timestamp (WhatsApp, screenshots and some S3 re-encodes strip EXIF). We only
 * reject when a real timestamp exists AND is more than 7 days in the past, so
 * genuine claimants are never blocked by missing metadata.
 *
 * @param {Buffer} buffer  Raw image bytes.
 * @returns {{ tooOld: boolean, ageDays: number }}
 */
async function checkPhotoAge(buffer) {
  if (!exifr) return { tooOld: false, ageDays: 0 };

  let exif = null;
  try {
    exif = await exifr.parse(buffer, { tiff: true, exif: true });
  } catch (err) {
    logger.warn(`[ai] could not read photo EXIF for age check: ${err.message}`);
    return { tooOld: false, ageDays: 0 };
  }

  const taken = exif && (exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate);
  if (!taken) return { tooOld: false, ageDays: 0 }; // no timestamp — allow.

  const takenMs = new Date(taken).getTime();
  if (!Number.isFinite(takenMs)) return { tooOld: false, ageDays: 0 };

  const ageMs = Date.now() - takenMs;
  // Future timestamps (camera clock skew) are treated as recent, not rejected.
  if (ageMs <= MAX_PHOTO_AGE_MS) return { tooOld: false, ageDays: 0 };
  return { tooOld: true, ageDays: Math.floor(ageMs / DAY_MS) };
}

/**
 * Validate an in-memory image (used by the pre-upload gate).
 * @param {Buffer} buffer     Raw image bytes.
 * @param {string} mimetype   e.g. 'image/jpeg'.
 * @param {Object} [meta]     Usage attribution ({ sessionKey, claimId, customerId }).
 * @returns {Object} { valid, category, quality, reason }
 */
async function validatePhoto(buffer, mimetype, meta = {}) {
  if (!buffer || !buffer.length) {
    return { valid: false, category: 'irrelevant', quality: 'poor', reason: 'No image data received.' };
  }
  if (!ALLOWED_MEDIA.includes(mimetype)) {
    return {
      valid: false,
      category: 'irrelevant',
      quality: 'poor',
      reason: 'Unsupported image type — please upload a JPG, PNG or WebP photo.',
    };
  }

  // Recency gate — runs before the vision call so we never spend tokens
  // classifying an out-of-date photo.
  const age = await checkPhotoAge(buffer);
  if (age.tooOld) {
    return {
      valid: false,
      category: 'irrelevant',
      quality: 'good',
      reason: `This photo was taken ${age.ageDays} days ago — please upload a photo taken within the last ${MAX_PHOTO_AGE_DAYS} days.`,
    };
  }

  return classify({ type: 'base64', media_type: mimetype, data: buffer.toString('base64') }, meta);
}

const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // Anthropic's per-image ceiling.

/**
 * Fetch image bytes ourselves (rather than letting the model fetch the URL,
 * which fails on robots.txt / redirects / private buckets). Returns null on any
 * failure so the caller can decide how to handle it.
 */
async function fetchImageBytes(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'AVE-Insurance-ClaimBot/1.0', Accept: 'image/*' },
    });
    if (!res.ok) {
      logger.warn(`[ai] could not fetch image for validation (${res.status}): ${url}`);
      return null;
    }
    const mimetype = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_MEDIA.includes(mimetype)) {
      return { mimetype, buffer: null }; // known type but unsupported
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) {
      logger.warn(`[ai] image too large to validate (${buffer.length} bytes): ${url}`);
      return null;
    }
    return { mimetype, buffer };
  } catch (err) {
    logger.warn(`[ai] image fetch failed for validation: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validate an already-uploaded image by URL. This is the SERVER-SIDE gate the
 * claim-intake endpoint uses on every attached photo, so validation cannot be
 * bypassed by a frontend that uploads straight to storage. The bytes are
 * fetched here and sent to the model as base64 — we never rely on the model
 * fetching the URL, which is unreliable.
 * @param {string} url  Fetchable image URL (e.g. S3 location).
 * @param {Object} [meta]  Usage attribution ({ sessionKey, claimId, customerId }).
 * @returns {Object} { valid, category, quality, reason, url }
 */
async function validatePhotoUrl(url, meta = {}) {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { valid: false, category: 'irrelevant', quality: 'poor', reason: 'Invalid image URL.', url };
  }
  const fetched = await fetchImageBytes(url);
  if (fetched && fetched.buffer === null) {
    return {
      valid: false,
      category: 'irrelevant',
      quality: 'poor',
      reason: 'Unsupported image type — please upload a JPG, PNG or WebP photo.',
      url,
    };
  }
  if (!fetched) {
    // We could not retrieve the image. Fail OPEN so a storage/network blip never
    // blocks a genuine claim, but this is logged above for follow-up.
    return { valid: true, category: 'other_document', quality: 'good', reason: 'Could not fetch image — allowed.', url };
  }
  const result = await validatePhoto(fetched.buffer, fetched.mimetype, meta);
  return { ...result, url };
}

module.exports = { validatePhoto, validatePhotoUrl, CATEGORIES };
