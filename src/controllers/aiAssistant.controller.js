const { runClaimIntake, intakeSessionKey } = require('../ai/agents/claimIntake.agent');
const { runStaffAssistant } = require('../ai/agents/staffAssistant.agent');
const { validatePhoto, validatePhotoUrl } = require('../ai/agents/photoValidator');
const { renderIntakePage } = require('../ai/intakePage');
const claimService = require('../service/claim.service');
const Customer = require('../models/customerModel');
const logger = require('../middlewheres/logger');
const { getRequesterCompany } = require('../utils/requesterCompany');

/**
 * GET /ai/claim-intake/:token
 * Serves the browser chat page. The page itself POSTs to the same path to talk
 * to the agent. Token validation happens on the POST (so the page can render
 * friendly errors in-chat).
 */
const claimIntakePage = (req, res) => {
  res.type('html').send(renderIntakePage(req.params.token));
};

/**
 * Shared claim-intake turn handler for both auth paths (secure-link token and
 * app JWT). Parses the turn, runs the server-side photo gate, drives the agent,
 * and responds. `identity` supplies who is filing and how:
 *   { customer, token }            — secure-link path (files via ClaimToken)
 *   { customer, fileClaim }        — JWT path (files for the authenticated customer)
 *
 * Body: { messages?: AnthropicMessage[], userMessage: string, images?: string[],
 *         videos?: string[], coordinates?: { latitude, longitude } }
 *  - `messages`     : prior conversation returned by the previous response (opaque
 *                     to the client; empty/absent on the first turn).
 *  - `userMessage`  : the claimant's new message this turn.
 *  - `images`       : URLs of photos attached this turn.
 *
 * Every attached photo is validated SERVER-SIDE here (not just in the client),
 * so irrelevant images can't reach the claim regardless of which frontend or
 * upload path was used. If any photo is irrelevant, the turn is rejected and
 * nothing is recorded.
 *
 * Returns: { messages, reply, status: 'collecting'|'submitted', claimId? }
 */
const runIntakeTurn = async (req, res, identity) => {
  const { messages = [], userMessage, images = [], videos = [], coordinates } = req.body || {};
  if (!userMessage || typeof userMessage !== 'string') {
    return res.status(400).json({ message: 'userMessage is required' });
  }

  const priorMessages = Array.isArray(messages) ? messages : [];
  const photoUrls = (Array.isArray(images) ? images : []).filter((u) => typeof u === 'string' && u);
  // Videos aren't run through the vision gate (they can't be classified) — they
  // are forwarded straight to the agent, which records them as evidence links.
  const videoUrls = (Array.isArray(videos) ? videos : []).filter((u) => typeof u === 'string' && u);

  // Best-effort device location from the client. Only accepted as a finite
  // lat/long pair; the assistant OFFERS it as the incident location and must
  // confirm with the claimant before saving it (see claimIntake.agent).
  const coords =
    coordinates &&
    typeof coordinates === 'object' &&
    Number.isFinite(coordinates.latitude) &&
    Number.isFinite(coordinates.longitude)
      ? { latitude: coordinates.latitude, longitude: coordinates.longitude }
      : null;

  // Server-side photo gate: reject the turn if any attached photo is not a
  // vehicle, damage, accident scene, or supporting document.
  if (photoUrls.length > 0) {
    // Same session key as the agent turns, so this spend is attributed to the
    // claim once it is filed.
    const usageMeta = {
      sessionKey: intakeSessionKey(identity.token, identity.customer),
      customerId: identity.customer && identity.customer._id,
      company: identity.customer && identity.customer.company,
    };
    const checks = await Promise.all(photoUrls.map((url) => validatePhotoUrl(url, usageMeta)));
    const rejected = checks.filter((c) => !c.valid);
    if (rejected.length > 0) {
      const reason = rejected[0].reason || "that photo doesn't look claim-related";
      return res.status(200).json({
        messages: priorMessages, // don't record the rejected photo
        reply:
          `I couldn't use ${rejected.length > 1 ? 'those photos' : 'that photo'} — ${reason} ` +
          'Please send a clear photo of the vehicle, the damage, the accident scene, or a document ' +
          '(driving licence, insurance sticker).',
        status: 'collecting',
      });
    }
  }

  const result = await runClaimIntake({
    customer: identity.customer,
    token: identity.token,
    fileClaim: identity.fileClaim,
    messages: priorMessages,
    userMessage,
    images: photoUrls,
    videos: videoUrls,
    coordinates: coords,
    req,
  });

  return res.status(200).json(result);
};

/**
 * POST /ai/claim-intake/:token   (secure-link token via verifyClaimToken)
 * Files through the one-time ClaimToken.
 */
const claimIntake = async (req, res) => {
  try {
    return await runIntakeTurn(req, res, {
      customer: req.customer,
      token: req.claimToken.token,
    });
  } catch (err) {
    logger.error(`claimIntake error: ${err.message}`);
    res.status(500).json({ message: err.message || 'Claim assistant error' });
  }
};

/**
 * POST /ai/claim-intake   (customer JWT via verifyToken)
 *
 * Mobile-app entry point: the logged-in customer drives the same conversational
 * agent, but files under their authenticated identity instead of a secure link.
 * Same request/response contract as the token endpoint.
 */
const claimIntakeJwt = async (req, res) => {
  try {
    const customer = await Customer.findById(req.user && req.user.id);
    if (!customer) {
      return res.status(404).json({ message: 'Customer account not found' });
    }
    return await runIntakeTurn(req, res, {
      customer,
      fileClaim: (draft, request) => claimService.fileClaimForCustomer(customer, draft, request),
    });
  } catch (err) {
    logger.error(`claimIntakeJwt error: ${err.message}`);
    res.status(500).json({ message: err.message || 'Claim assistant error' });
  }
};

/**
 * POST /ai/claim-intake/:token/validate-photo   (token-authenticated)
 *
 * Multipart body: field `image`. Runs a cheap vision check and returns whether
 * the photo is claim-relevant. The intake page calls this BEFORE uploading to
 * S3, so irrelevant/junk images are rejected and never stored.
 *
 * Returns: { valid, category, quality, reason }
 */
const validateClaimPhoto = async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ message: 'No image uploaded' });
    }
    // Pre-upload gate runs on both auth paths: secure-link token or customer JWT.
    const usageMeta = {
      sessionKey: intakeSessionKey(
        req.claimToken && req.claimToken.token,
        req.customer || (req.user && { _id: req.user.id })
      ),
      customerId: (req.customer && req.customer._id) || (req.user && req.user.id),
      company: (req.customer && req.customer.company) || (req.user && req.user.company),
    };
    const result = await validatePhoto(req.file.buffer, req.file.mimetype, usageMeta);
    res.status(200).json(result);
  } catch (err) {
    logger.error(`validateClaimPhoto error: ${err.message}`);
    res.status(500).json({ message: err.message || 'Photo validation error' });
  }
};

/**
 * POST /ai/staff-assistant   (staff JWT via verifyToken)
 *
 * Body: { messages?: AnthropicMessage[], userMessage: string }
 * Returns: { messages, reply }   — read-only Q&A over operational data + KB.
 */
const staffAssistant = async (req, res) => {
  try {
    const { messages = [], userMessage } = req.body || {};
    if (!userMessage || typeof userMessage !== 'string') {
      return res.status(400).json({ message: 'userMessage is required' });
    }
    // Tenant scope for the read-only tools: company users (and any actor token
    // carrying a company claim) only query their own company's data; AVE
    // platform staff resolve to null → global scope.
    const company = await getRequesterCompany(req);
    const result = await runStaffAssistant({
      user: req.user,
      company,
      messages: Array.isArray(messages) ? messages : [],
      userMessage,
    });
    res.status(200).json(result);
  } catch (err) {
    logger.error(`staffAssistant error: ${err.message}`);
    res.status(500).json({ message: err.message || 'Staff assistant error' });
  }
};

module.exports = { claimIntake, claimIntakeJwt, claimIntakePage, validateClaimPhoto, staffAssistant };
