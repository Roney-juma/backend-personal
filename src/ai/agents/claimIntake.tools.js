/**
 * Tools for the conversational claim-intake agent.
 *
 * Design notes:
 * - The claim DRAFT is never stored server-side. It is reconstructed on each
 *   call by deep-merging every `set_claim_details` partial found in the
 *   conversation history. This keeps the whole flow stateless — the client
 *   resends the message history each turn.
 * - `submit_claim` is the only write. It re-validates required fields and
 *   requires explicit confirmation before calling the existing fileClaimService.
 */
const moment = require('moment-timezone');
const claimService = require('../../service/claim.service');

// Timezone the claim's dates are interpreted in (default Kenya). "Today" and the
// future-date check are computed here, not in server UTC.
const CLAIM_TZ = process.env.CLAIM_TIMEZONE || 'Africa/Nairobi';

// ---- tool schemas (sent to the model) -------------------------------------

const TOOLS = [
  {
    name: 'set_claim_details',
    description:
      'Record claim details the claimant has provided. Call this whenever the ' +
      'claimant gives new incident, vehicle, or driver information. Send only the ' +
      'fields you have; you may call it multiple times as the conversation goes. ' +
      'For list fields (vehiclesInvolved, drivers, passengers, injuries, witnesses, ' +
      'supportingDocuments.photos, supportingDocuments.videos) always send the COMPLETE current list, not a delta. ' +
      'Do NOT include claimant name/phone/email/address — those are already known.',
    input_schema: {
      type: 'object',
      properties: {
        incidentDetails: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'ISO date of the incident' },
            time: { type: 'string' },
            location: { type: 'string' },
            longitude: { type: 'number' },
            latitude: { type: 'number' },
            description: { type: 'string' },
            weatherConditions: { type: 'string' },
            roadConditions: { type: 'string' },
          },
        },
        vehiclesInvolved: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              make: { type: 'string' },
              model: { type: 'string' },
              year: { type: 'number' },
              VIN: { type: 'string' },
              licensePlate: { type: 'string' },
            },
          },
        },
        drivers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              contactInfo: {
                type: 'object',
                properties: {
                  phone: { type: 'string' },
                  email: { type: 'string' },
                },
              },
              driverLicenseNumber: { type: 'string' },
            },
          },
        },
        damage: {
          type: 'object',
          properties: {
            yourVehicle: { type: 'string' },
            otherVehicles: { type: 'string' },
            property: { type: 'string' },
          },
        },
        description: { type: 'string' },
        damagedParts: { type: 'string' },
        injuries: { type: 'array', items: { type: 'object' } },
        witnesses: { type: 'array', items: { type: 'object' } },
        policeReport: { type: 'object' },
        supportingDocuments: {
          type: 'object',
          properties: {
            photos: { type: 'array', items: { type: 'string' } },
            videos: { type: 'array', items: { type: 'string' } },
          },
        },
        additionalInfo: { type: 'object' },
      },
    },
  },
  {
    name: 'submit_claim',
    description:
      'File the claim. ONLY call this after (1) all required fields are present and ' +
      '(2) you have shown the claimant a summary and they have explicitly confirmed. ' +
      'Pass confirmed=true to acknowledge the claimant agreed.',
    input_schema: {
      type: 'object',
      properties: {
        confirmed: { type: 'boolean', description: 'true once the claimant confirms the summary' },
      },
      required: ['confirmed'],
    },
  },
];

// ---- helpers ---------------------------------------------------------------

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function deepMerge(target, source) {
  const out = { ...target };
  for (const [k, v] of Object.entries(source || {})) {
    if (Array.isArray(v)) out[k] = v; // lists are sent complete -> replace
    else if (isObj(v)) out[k] = deepMerge(isObj(out[k]) ? out[k] : {}, v);
    else if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

/**
 * Rebuild the claim draft from every set_claim_details call in the history.
 * `messages` is the Anthropic-format array; tool_use blocks carry the inputs.
 */
function reconstructDraft(messages) {
  let draft = {};
  for (const msg of messages || []) {
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (block.type === 'tool_use' && block.name === 'set_claim_details') {
        draft = deepMerge(draft, block.input || {});
      }
    }
  }
  return draft;
}

/** Return a list of human-readable missing required fields. */
function missingRequired(draft) {
  const missing = [];
  const inc = draft.incidentDetails || {};
  ['date', 'time', 'location', 'description'].forEach((f) => {
    if (!inc[f]) missing.push(`incident ${f}`);
  });
  // Coordinates are required by the claim schema. They come from the browser and
  // are confirmed by the claimant during the chat — block filing without them.
  if (inc.latitude == null || inc.longitude == null) {
    missing.push('incident location coordinates (latitude & longitude)');
  }

  const vehicles = draft.vehiclesInvolved || [];
  if (vehicles.length === 0) missing.push('at least one vehicle (make, model, year, licence plate)');
  vehicles.forEach((v, i) => {
    ['make', 'model', 'year', 'licensePlate'].forEach((f) => {
      if (!v[f]) missing.push(`vehicle ${i + 1} ${f}`);
    });
  });

  const drivers = draft.drivers || [];
  if (drivers.length === 0) missing.push('at least one driver (name, phone, email, licence number)');
  drivers.forEach((d, i) => {
    if (!d.name) missing.push(`driver ${i + 1} name`);
    if (!d.contactInfo || !d.contactInfo.phone) missing.push(`driver ${i + 1} phone`);
    if (!d.contactInfo || !d.contactInfo.email) missing.push(`driver ${i + 1} email`);
    if (!d.driverLicenseNumber) missing.push(`driver ${i + 1} licence number`);
  });

  // Require at least TWO supporting photos so the assessor has more than a single
  // angle to work from. (The DB schema still only enforces one.)
  const photos = (draft.supportingDocuments && draft.supportingDocuments.photos) || [];
  if (photos.length < 2) missing.push(`at least two supporting photos (${photos.length} attached so far)`);

  return missing;
}

/**
 * Deterministic validation of the incident date: it must be a real date and it
 * MUST NOT be in the future. Returns human-readable issues (empty = fine). This
 * backs up the model's own resolution so a bad date can never be filed.
 */
function dateIssues(draft) {
  const issues = [];
  const raw = draft.incidentDetails && draft.incidentDetails.date;
  if (!raw) return issues; // absence is handled by missingRequired

  // Strict parse against the formats the model is told to use (ISO date first).
  const FORMATS = ['YYYY-MM-DD', moment.ISO_8601, 'YYYY-MM-DDTHH:mm:ss', 'YYYY-MM-DD HH:mm'];
  const d = moment.tz(raw, FORMATS, true, CLAIM_TZ);
  if (!d.isValid()) {
    issues.push(`incident date "${raw}" is not a valid date`);
    return issues;
  }
  const today = moment.tz(CLAIM_TZ).startOf('day');
  if (d.startOf('day').isAfter(today)) {
    issues.push('incident date cannot be in the future');
  }
  return issues;
}

/**
 * Optional fields that are still empty. The agent uses this to OFFER to add
 * them before filing, rather than skipping them silently. Never blocks submit.
 */
function missingOptional(draft) {
  const optional = [];
  const dmg = draft.damage || {};
  if (!dmg.otherVehicles && !dmg.property) optional.push('damage to other vehicles or property');
  if ((draft.injuries || []).length === 0) optional.push('injuries');
  if ((draft.witnesses || []).length === 0) optional.push('witnesses');
  const pr = draft.policeReport || {};
  if (!pr.reportNumber) optional.push('police report details');
  const towing = (draft.additionalInfo || {}).towingDetails || {};
  if (!towing.company && !towing.location) optional.push('towing details');
  const videos = (draft.supportingDocuments || {}).videos || [];
  if (videos.length === 0) optional.push('a video of the accident or damage');
  return optional;
}

// ---- tool executors --------------------------------------------------------

/**
 * Execute a tool_use block.
 * @returns {Object} { content: <string for tool_result>, isError, submitted, claim }
 */
async function executeTool(block, ctx) {
  const { messages, token, req } = ctx;

  if (block.name === 'set_claim_details') {
    // Merge the prior draft with THIS partial (this block isn't in `messages` yet).
    const draft = deepMerge(reconstructDraft(messages), block.input || {});
    const missing = missingRequired(draft);
    const dateProblems = dateIssues(draft);
    return {
      content: JSON.stringify({
        accepted: true,
        missingRequired: missing,
        missingOptional: missingOptional(draft),
        dateIssues: dateProblems,
        complete: missing.length === 0 && dateProblems.length === 0,
      }),
    };
  }

  if (block.name === 'submit_claim') {
    const draft = reconstructDraft(messages);
    const missing = missingRequired(draft);
    if (!block.input || block.input.confirmed !== true) {
      return { content: JSON.stringify({ error: 'Not submitted: confirmation required.' }), isError: true };
    }
    if (missing.length > 0) {
      return {
        content: JSON.stringify({ error: 'Not submitted: missing required fields.', missingRequired: missing }),
        isError: true,
      };
    }
    const dateProblems = dateIssues(draft);
    if (dateProblems.length > 0) {
      return {
        content: JSON.stringify({ error: 'Not submitted: invalid incident date.', dateIssues: dateProblems }),
        isError: true,
      };
    }
    try {
      const claim = await claimService.fileClaimService(token, draft, req);
      return {
        content: JSON.stringify({ submitted: true, claimId: claim._id, status: claim.status }),
        submitted: true,
        claim,
      };
    } catch (err) {
      return { content: JSON.stringify({ error: err.message }), isError: true };
    }
  }

  return { content: JSON.stringify({ error: `Unknown tool: ${block.name}` }), isError: true };
}

module.exports = { TOOLS, executeTool, reconstructDraft, missingRequired, missingOptional, dateIssues, CLAIM_TZ };
