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

// Fast, cheap model for a yes/no-style classification.
const FAST_MODEL = process.env.ANTHROPIC_MODEL_FAST || 'claude-haiku-4-5';

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
async function validatePhoto(buffer, mimetype) {
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

  const cost = new CostTracker('photo-validate');
  try {
    const response = await complete({
      model: FAST_MODEL,
      system: SYSTEM,
      maxTokens: 256,
      tools: [CHECK_TOOL],
      toolChoice: { type: 'tool', name: 'report_photo_check' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimetype, data: buffer.toString('base64') } },
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

module.exports = { validatePhoto, CATEGORIES };
