/**
 * Conversational claim-intake agent.
 *
 * Drives a manual Claude tool-use loop: the model collects claim details from
 * the claimant, then files the claim through the existing fileClaimService.
 * Stateless — the caller passes the full message history each turn and gets
 * the updated history back to persist client-side.
 */
const moment = require('moment-timezone');
const { complete } = require('../llm/claude');
const { CostTracker } = require('../llm/cost');
const { TOOLS, executeTool, CLAIM_TZ } = require('./claimIntake.tools');
const logger = require('../../middlewheres/logger');

const MAX_TOOL_ROUNDS = 6; // bound the loop per turn

/**
 * Human-readable "now" block injected into the system prompt so the model can
 * resolve relative dates ("yesterday", "last week thursday") itself. Computed in
 * the claim timezone (default Africa/Nairobi), not server UTC.
 */
function dateContext(now = moment.tz(CLAIM_TZ)) {
  return [
    `DATE CONTEXT (use this to resolve any relative date the claimant gives)`,
    `- Today is ${now.format('dddd, D MMMM YYYY')} (timezone ${CLAIM_TZ}).`,
    `- The current time is ${now.format('HH:mm')}.`,
    `- Resolve natural-language dates yourself against today: e.g. "yesterday", "the day before yesterday", "last week Thursday", "3 days ago", "last Friday". Work out the concrete calendar date.`,
    `- Record incidentDetails.date as an ISO date (YYYY-MM-DD). Record time separately if given.`,
    `- ALWAYS restate the resolved date in words for confirmation before saving it — e.g. "so that's Monday, 29 June 2026 — is that right?".`,
    `- An incident CANNOT be in the future. If the resolved date is after today, tell the claimant an accident date can't be in the future and ask them to clarify. Never file a claim with a future incident date.`,
    ``,
  ];
}

/**
 * Optional device-location block. Browser geolocation reports where the
 * claimant is filing FROM, which may not be the accident scene — so the model
 * is told to OFFER it and confirm, never to assume it as the incident location.
 */
function locationContext(coordinates) {
  if (!coordinates || !Number.isFinite(coordinates.latitude) || !Number.isFinite(coordinates.longitude)) {
    return [];
  }
  return [
    `DEVICE LOCATION (reported by the claimant's browser this session)`,
    `- Current coordinates: latitude ${coordinates.latitude}, longitude ${coordinates.longitude}.`,
    `- These are where the claimant is RIGHT NOW — which may or may not be where the accident happened.`,
    `- If they are filing from the accident scene, OFFER to use these as the incident location and record them via set_claim_details incidentDetails.latitude/longitude once they confirm.`,
    `- If they are not at the scene, ask them to describe the incident location instead. NEVER save these coordinates unless the claimant confirms they match where the accident happened.`,
    ``,
  ];
}

function buildSystem(customer, now = moment.tz(CLAIM_TZ), coordinates = null) {
  const name = `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || 'the claimant';
  return [
    `You are AVE Insurance's claim-intake assistant. You help a known policyholder file a motor-insurance claim through a friendly, step-by-step chat.`,
    ``,
    `CLAIMANT (already verified via their secure link — do NOT ask for these):`,
    `- Name: ${name}`,
    `- Phone: ${customer.phone || 'on file'}`,
    `- Email: ${customer.email || 'on file'}`,
    `- Policy number: ${customer.policyNumber || 'on file'}`,
    ``,
    ...locationContext(coordinates),
    ...dateContext(now),
    `YOUR JOB`,
    `- Greet ${name} by name on the first turn and explain you'll help report the incident.`,
    `- Collect the required details conversationally, a few at a time. Record everything via the set_claim_details tool as you learn it.`,
    `- REQUIRED before filing: incident date, time, location and description; for each vehicle make, model, year and licence plate; for each driver name, phone, email and licence number.`,
    `- Optional (ask briefly, don't insist): other-vehicle/property damage, injuries, witnesses, police report, photos.`,
    `- Proactively invite helpful photos: the damaged vehicle from a few angles, the driving licence, the insurance sticker/disc, and the wider scene of the accident. Explain these speed up assessment.`,
    ``,
    `PHOTOS & DOCUMENTS (you can SEE the images the claimant uploads)`,
    `- When a photo is attached, an "(attached photo URL: ...)" line accompanies it. ALWAYS record that exact URL in supportingDocuments.photos via set_claim_details (send the complete list).`,
    `- Look at each image and briefly acknowledge what you see (e.g. "I can see the dented rear bumper").`,
    `- QUALITY CHECK: if an image is blurry, too dark, cropped, or the detail is unreadable, say so plainly and ask for a clearer retake before moving on.`,
    `- OCR CONFIRMATION: if the image is a DRIVING LICENCE, read the licence number (and holder name) and confirm it back — e.g. "I read the licence number as DL-12345 — is that correct?". Only save it to the matching driver's driverLicenseNumber AFTER the claimant confirms. If you cannot read it confidently, ask them to type it.`,
    `- If the image is an INSURANCE STICKER/DISC, read the policy/certificate number and expiry and confirm them back the same way; record confirmed values in additionalInfo.`,
    `- For damage or scene photos, note what they show in the incident description if it adds detail. Never guess at text you cannot actually read.`,
    ``,
    `RULES`,
    `- Never invent or assume details. If unsure, ask. Never state an OCR reading as fact until the claimant confirms it.`,
    `- Do not ask for the claimant's name, phone, email, or address — you already have them.`,
    `- Only ask for what is still missing (the set_claim_details tool tells you what's outstanding — both missingRequired and missingOptional).`,
    `- Before filing, once the required fields are complete, go through the still-empty OPTIONAL items (from missingOptional: other-vehicle/property damage, injuries, witnesses, police report, towing) and OFFER to add them — e.g. "Would you like to add any injuries or witnesses? You can also skip." Do not force them; if the claimant declines, move on.`,
    `- When nothing required is missing, show a clear plain-language SUMMARY of the claim and ask the claimant to confirm before filing.`,
    `- Only call submit_claim AFTER the claimant explicitly confirms, with confirmed=true. Never file without confirmation.`,
    `- Keep replies concise and warm. Respond with your message to the claimant only — no internal notes.`,
  ].join('\n');
}

/**
 * Build the user turn content. With no images it stays a plain string (cheapest).
 * With images we send a text block plus one vision image block per URL, and echo
 * each URL in the text so the model can record it in supportingDocuments.photos.
 */
function buildUserTurn(userMessage, images = []) {
  const urls = (Array.isArray(images) ? images : []).filter((u) => typeof u === 'string' && u);
  if (urls.length === 0) return userMessage;

  const text = [userMessage, ...urls.map((u) => `(attached photo URL: ${u})`)].join('\n');
  return [
    { type: 'text', text },
    ...urls.map((url) => ({ type: 'image', source: { type: 'url', url } })),
  ];
}

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

/**
 * Run one user turn through the agent.
 *
 * @param {Object} params
 * @param {Object} params.customer    Customer doc (identity).
 * @param {string} params.token       Claim token (credential for filing).
 * @param {Array}  params.messages    Prior Anthropic-format history (may be []).
 * @param {string} params.userMessage New user text for this turn.
 * @param {Array}  [params.images]    S3 URLs of photos attached this turn; passed
 *                                    to the model as vision image blocks.
 * @param {Object} [params.coordinates] Optional { latitude, longitude } from the
 *                                    browser; offered to the claimant as the
 *                                    incident location (never assumed).
 * @param {Object} params.req         Express req (for fileClaimService audit log).
 * @returns {Object} { messages, reply, status, claimId }
 */
async function runClaimIntake({ customer, token, messages = [], userMessage, images = [], coordinates = null, req }) {
  const system = buildSystem(customer, moment.tz(CLAIM_TZ), coordinates);
  const working = [...messages, { role: 'user', content: buildUserTurn(userMessage, images) }];
  const cost = new CostTracker('claim-intake');

  let status = 'collecting';
  let claimId = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await complete({ system, messages: working, tools: TOOLS, maxTokens: 1024 });
    cost.record(response);

    // Persist the assistant turn (text + any tool_use blocks) into history.
    working.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      cost.flush();
      return { messages: working, reply: textOf(response.content), status, claimId };
    }

    // Execute every tool_use block and feed results back.
    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    const toolResults = [];
    for (const block of toolUses) {
      const result = await executeTool(block, { messages: working, token, req });
      if (result.submitted) {
        status = 'submitted';
        claimId = result.claim._id;
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result.content,
        ...(result.isError ? { is_error: true } : {}),
      });
    }
    working.push({ role: 'user', content: toolResults });

    if (cost.exceeded()) {
      cost.flush();
      logger.warn(`[ai] claim-intake hit token ceiling for token ${token}`);
      working.push({
        role: 'assistant',
        content: [{ type: 'text', text: "Let's pause here — please continue in a moment." }],
      });
      return { messages: working, reply: "Let's pause here — please continue in a moment.", status, claimId };
    }
  }

  // Safety net: ran out of tool rounds without a final text turn.
  cost.flush();
  return {
    messages: working,
    reply: 'Sorry, something went wrong on my side. Could you repeat that?',
    status,
    claimId,
  };
}

module.exports = { runClaimIntake, buildSystem };
