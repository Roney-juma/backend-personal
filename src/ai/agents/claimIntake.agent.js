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
const { attributeSessionToClaim } = require('../llm/usage');
const { FEATURES } = require('../features');
const { TOOLS, executeTool, CLAIM_TZ } = require('./claimIntake.tools');
const claimTypeService = require('../../service/claimType.service');
const logger = require('../../middlewheres/logger');
const { formatMinor } = require('../../utils/money');

const MAX_TOOL_ROUNDS = 6; // bound the loop per turn

/**
 * Stable key for one intake conversation, shared by the agent turns and the
 * photo gate so all pre-claim spend can be attributed to the claim once filed.
 */
const intakeSessionKey = (token, customer) =>
  token ? `intake:${token}` : `customer:${(customer && customer._id) || 'unknown'}`;

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

/**
 * Claim-type block. The kind of claim is chosen FIRST, before incident details.
 * The active types are read from the DB and listed by name; the model records
 * the chosen type's id (never invents one). Empty when types can't be loaded —
 * the agent then skips the step rather than blocking (see missingRequired).
 */
function claimTypeContext(claimTypes) {
  if (!Array.isArray(claimTypes) || claimTypes.length === 0) return [];
  const lines = claimTypes.map(
    (t) => `  - ${t.name}${t.description ? ` — ${t.description}` : ''}  (claimTypeId: ${t._id})`,
  );
  return [
    `CLAIM TYPES (what kind of claim this is — establish this FIRST, before any incident details)`,
    `- Right after greeting, ask the claimant which of these best describes their claim, listing the options by NAME only (never show or mention the ids):`,
    ...lines,
    `- Once they choose, record that type's claimTypeId via set_claim_details. Use ONLY an id from this list — never invent one. If their situation doesn't clearly match one, ask a brief clarifying question before deciding.`,
    ``,
  ];
}

/**
 * The vehicles this customer is insured for, straight off their policies.
 *
 * The insurer already knows what the claimant drives — it is on the policy book
 * that created their record. Asking them to type the make, model, year and plate
 * of a car we hold the chassis number for is both a poor first impression and a
 * source of mismatches: "Toyota Prado" against a book that says "TOYOTA LAND
 * CRUISER PRADO" is a reconciliation problem nobody needed.
 *
 * A customer commonly holds several policies, so this lists them and lets the
 * claimant pick. Policy status travels with each one: a claim on a lapsed policy
 * is still worth taking, but the assistant must not imply it will be paid.
 */
function insuredVehicleContext(customer) {
  const policies = (customer.policies || []).filter((p) => p.vehicle && (p.vehicle.registration || p.vehicle.make));
  if (policies.length === 0) {
    return [
      `INSURED VEHICLE`,
      `- We have no vehicle on file for this claimant, so ask for the make, model, year and licence plate as normal.`,
      ``,
    ];
  }

  /**
   * Each car with the policy that covers it. The cover matters during intake,
   * not just afterwards: an excess is the first thing a claimant asks about, and
   * an expiry date that falls before the incident is something to establish now
   * rather than to discover at assessment.
   */
  const describe = (p) => {
    const v = p.vehicle;
    const car = [v.year, v.make, v.model].filter(Boolean).join(' ') || 'Vehicle';
    const reg = v.registration ? ` — ${v.registration}` : '';

    const detail = [
      `policy ${p.policyNumber}`,
      p.policyType,
      p.status ? `status ${p.status}` : null,
      p.expiryDate ? `expires ${moment(p.expiryDate).tz(CLAIM_TZ).format('D MMM YYYY')}` : null,
      Number.isFinite(p.excessMinor) && p.excessMinor > 0 ? `excess ${formatMinor(p.excessMinor)}` : null,
      v.chassisNumber ? `chassis ${v.chassisNumber}` : null,
    ].filter(Boolean);

    const flag = p.status && p.status !== 'active' ? ` [POLICY ${String(p.status).toUpperCase()}]` : '';
    return `  - ${car}${reg} (${detail.join(', ')})${flag}`;
  };

  const single = policies.length === 1;
  return [
    `INSURED VEHICLE${single ? '' : 'S'} ON FILE (${policies.length})`,
    ...policies.map(describe),
    single
      ? `- Confirm this is the vehicle involved rather than asking them to type it out: "I have your <year make model>, registration <reg> — is that the vehicle involved?" If they say yes, record it via set_claim_details and move on.`
      : `- This claimant has several vehicles with us. Ask WHICH ONE the claim is for, listing them by year, make, model and registration, and let them answer with the registration or by naming the car. Do not ask them to type the details out.`,
    `- Once they choose, record that vehicle's make, model, year and licencePlate in vehiclesInvolved via set_claim_details, and put its policy number in additionalInfo. Take the details from this list, not from what the claimant types, so they match the policy book exactly.`,
    `- The policy details above are for YOUR reference and for answering questions. If the claimant asks what their excess is, or whether they are still covered, answer from this list. Do not read the chassis number or the whole policy back at them unprompted — it is not what they need while reporting an accident.`,
    `- If the chosen policy EXPIRED BEFORE the incident date, say so plainly and kindly, take the claim anyway, and let the insurer decide. Never turn a claimant away.`,
    `- If the vehicle involved is NOT one of these (a courtesy car, a newly bought car not yet on cover, someone else's vehicle), say that is fine and collect its details as normal — but note in additionalInfo that it is not a vehicle on their policy.`,
    ...(policies.some((p) => p.status && p.status !== 'active')
      ? [
          `- One or more of these policies is not active. If the claimant picks such a vehicle, take the claim as normal and be kind about it, but say plainly that the policy shows as ${policies.find((p) => p.status !== 'active').status} and that the insurer will confirm cover. Never promise it will be paid, and never refuse to take the claim.`,
        ]
      : []),
    ``,
  ];
}

function buildSystem(customer, now = moment.tz(CLAIM_TZ), coordinates = null, claimTypes = []) {
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
    ...insuredVehicleContext(customer),
    ...claimTypeContext(claimTypes),
    ...locationContext(coordinates),
    ...dateContext(now),
    `YOUR JOB`,
    `- Greet ${name} by name on the first turn and explain you'll help report the incident.`,
    `- FIRST, before collecting incident details, establish the CLAIM TYPE (see above) and record it via set_claim_details. Do this on the opening turn, right after greeting.`,
    `- Then collect the required details conversationally, a few at a time. Record everything via the set_claim_details tool as you learn it.`,
    `- REQUIRED before filing: the claim type; incident date, time, location and description; for each vehicle make, model, year and licence plate (take the insured vehicle's from the list above rather than asking); for each driver name, phone, email and licence number; the POLICE REPORT (report/OB number, officer name, and police station/department — required for EVERY claim, no exceptions); and at least TWO clear photos.`,
    `- If the claimant doesn't have a police report yet, explain kindly that one is required before the claim can be filed, and that they can return to this chat once they have the report details. Do not file without it, and never suggest it can be skipped or handled later.`,
    `- BE THOROUGH: ask plenty of follow-up questions to build a complete picture — how the accident happened step by step, direction and rough speed of travel, the point of impact, visible damage to each vehicle, any third parties or pedestrians, road/weather/lighting conditions, whether the vehicle is still driveable, and where it is now. Ask a few at a time so it feels like a friendly conversation, not an interrogation, but keep digging for detail the assessor would want.`,
    `- Optional (offer warmly, don't insist): other-vehicle/property damage, injuries, witnesses, towing, and videos.`,
    `- PHOTOS: politely ask for as MANY photos as possible — the wider accident scene, every angle of the damage, close-ups of the damaged parts, the other vehicle(s), number plates, and any skid marks, debris or road signs. Explain that more photos mean a faster, more accurate assessment. Keep gently encouraging more ("any other angles you can add?") until they say that's everything. At least two photos are required to file.`,
    `- VIDEOS: politely ask whether they have a video from the accident or scene, or can record a short walk-around video of the damage now. Explain that a video helps the assessor understand the damage faster, which speeds up the claim's resolution. Videos are optional — encourage them, but never block filing on them.`,
    ``,
    `PHOTOS, VIDEOS & DOCUMENTS (you can SEE the images the claimant uploads, but NOT videos)`,
    `- When a photo is attached, an "(attached photo URL: ...)" line accompanies it. ALWAYS record that exact URL in supportingDocuments.photos via set_claim_details (send the complete list).`,
    `- When a VIDEO is attached, an "(attached video URL: ...)" line accompanies it — you cannot watch it. Record that exact URL in supportingDocuments.videos via set_claim_details (send the complete list), thank them, and mention it will help the assessor.`,
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
    `- Before filing, once the required fields are complete, go through the still-empty OPTIONAL items (from missingOptional: other-vehicle/property damage, injuries, witnesses, towing, videos) and OFFER to add them — e.g. "Would you like to add any injuries, witnesses, or a video of the damage? You can also skip." Do not force them; if the claimant declines, move on.`,
    `- When nothing required is missing, show a clear plain-language SUMMARY of the claim and ask the claimant to confirm before filing.`,
    `- Only call submit_claim AFTER the claimant explicitly confirms, with confirmed=true. Never file without confirmation.`,
    `- IF SUBMISSION FAILS: read the error, tell the claimant plainly which details are still needed, and collect them — that is the ONLY path to filing. NEVER blame a "system fault" or "technical glitch", NEVER say a required field isn't actually required, and NEVER promise that a team will file the claim manually, "flag" it, or follow up on their behalf — no such escalation or manual-filing process exists. A claim is filed only when submit_claim succeeds; do not tell the claimant it is done or being handled otherwise.`,
    `- Keep replies concise and warm. Respond with your message to the claimant only — no internal notes.`,
    `- FORMATTING: write every reply in Markdown. Use **bold** for key terms, field labels and the resolved date you restate; use bullet lists ("- ") when offering options or listing collected details; use a numbered list for any step-by-step recap. Render the pre-filing SUMMARY as a clean bulleted list of the claim details. Keep it light — no headings, tables, or code blocks.`,
  ].join('\n');
}

/**
 * Build the user turn content. With no images it stays a plain string (cheapest).
 * With images we send a text block plus one vision image block per URL, and echo
 * each URL in the text so the model can record it in supportingDocuments.photos.
 */
function buildUserTurn(userMessage, images = [], videos = []) {
  const imgUrls = (Array.isArray(images) ? images : []).filter((u) => typeof u === 'string' && u);
  const vidUrls = (Array.isArray(videos) ? videos : []).filter((u) => typeof u === 'string' && u);
  if (imgUrls.length === 0 && vidUrls.length === 0) return userMessage;

  // Photos are echoed as vision blocks (the model can see them). Videos are only
  // echoed as a URL line — the model can't watch them, but records the link.
  const text = [
    userMessage,
    ...imgUrls.map((u) => `(attached photo URL: ${u})`),
    ...vidUrls.map((u) => `(attached video URL: ${u})`),
  ].join('\n');
  return [
    { type: 'text', text },
    ...imgUrls.map((url) => ({ type: 'image', source: { type: 'url', url } })),
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
 * @param {string} [params.token]     Claim token (credential for filing via the
 *                                    secure-link path). Omit when using fileClaim.
 * @param {Function} [params.fileClaim] Optional (draft, req) => Promise<claim>
 *                                    filing callback. Supplied by the JWT path
 *                                    (mobile app) so filing goes through the
 *                                    authenticated customer instead of a token.
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
async function runClaimIntake({ customer, token, fileClaim = null, messages = [], userMessage, images = [], videos = [], coordinates = null, req }) {
  // Active claim types drive the "what kind of claim" step. Fetched per turn and
  // fed to both the prompt (so the model can offer them) and the tools (so the
  // chosen id is required + validated). Falls back to [] if the load fails.
  let claimTypes = [];
  try {
    claimTypes = await claimTypeService.getAllClaimTypes(true, customer && customer.company);
  } catch (err) {
    logger.warn(`[ai] claim-intake could not load claim types: ${err.message}`);
  }

  const system = buildSystem(customer, moment.tz(CLAIM_TZ), coordinates, claimTypes);
  const working = [...messages, { role: 'user', content: buildUserTurn(userMessage, images, videos) }];
  const cost = new CostTracker(FEATURES.CLAIM_INTAKE);
  const sessionKey = intakeSessionKey(token, customer);
  const usageMeta = {
    feature: FEATURES.CLAIM_INTAKE,
    stage: 'intake',
    sessionKey,
    customerId: customer && customer._id,
    company: customer && customer.company,
  };

  let status = 'collecting';
  let claimId = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await complete({ system, messages: working, tools: TOOLS, maxTokens: 1024, meta: usageMeta });
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
      const result = await executeTool(block, { messages: working, token, fileClaim, claimTypes, req });
      if (result.submitted) {
        status = 'submitted';
        claimId = result.claim._id;
        // Stamp the claim onto this session's usage rows (agent turns + photo
        // checks) and onto any calls still to come this turn.
        usageMeta.claimId = claimId;
        attributeSessionToClaim(sessionKey, claimId);
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
      logger.warn(`[ai] claim-intake hit token ceiling for session ${token || (customer && customer._id) || 'unknown'}`);
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

module.exports = { runClaimIntake, buildSystem, intakeSessionKey };
