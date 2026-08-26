const recoveryService = require('../service/recovery.service');
const legalAnalytics = require('../service/legalAnalytics.service');
const legalRisk = require('../service/legalRisk.service');
const legalAssistant = require('../ai/agents/legalAssistant.agent');
const Recovery = require('../models/recovery.model');
const ThirdPartyClaim = require('../models/thirdPartyClaim.model');
const { getRequesterCompany, belongsToCompany } = require('../utils/requesterCompany');
const { writeAuditLog } = require('../utils/auditHelper');
const ApiError = require('../utils/ApiError');
const money = require('../utils/money');
const logger = require('../middlewheres/logger');

/**
 * Recovery, analytics and the AI assistant.
 */

const handle = (res, error) => res.status(error.statusCode || 400).json({ message: error.message });

async function scopedRecovery(req) {
  const company = await getRequesterCompany(req);
  const recovery = await Recovery.findById(req.params.id).select('company reference');
  if (!recovery) throw new ApiError(404, 'Recovery not found');
  if (!belongsToCompany(recovery.company, company)) throw new ApiError(404, 'Recovery not found');
  return { recovery, company };
}

// ── Recovery ─────────────────────────────────────────────────────────────────

const list = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    res.status(200).json(await recoveryService.list({ ...req.query, company }));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getById = async (req, res) => {
  try {
    await scopedRecovery(req);
    res.status(200).json(await recoveryService.getById(req.params.id));
  } catch (error) {
    handle(res, error);
  }
};

const create = async (req, res) => {
  try {
    const recovery = await recoveryService.create(req.body, req.user);

    await writeAuditLog(req, {
      action: 'CREATE',
      module: 'Legal',
      actionDescription:
        `Opened recovery ${recovery.reference} against ${recovery.recoverFrom.name} — ` +
        `${money.formatMinor(recovery.recoverableMinor)} recoverable`,
      resourceType: 'Recovery',
      resourceId: recovery._id,
      statusCode: 201,
      success: true,
    });

    res.status(201).json(recovery);
  } catch (error) {
    handle(res, error);
  }
};

const chase = async (req, res) => {
  try {
    await scopedRecovery(req);
    const recovery = await recoveryService.chase(req.params.id, req.body, req.user);
    res.status(200).json(recovery);
  } catch (error) {
    handle(res, error);
  }
};

const agree = async (req, res) => {
  try {
    await scopedRecovery(req);
    const recovery = await recoveryService.agree(req.params.id, req.body, req.user);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription:
        `Agreed recovery of ${money.formatMinor(recovery.agreedMinor)} on ${recovery.reference}`,
      resourceType: 'Recovery',
      resourceId: recovery._id,
      statusCode: 200,
      success: true,
    });

    res.status(200).json(recovery);
  } catch (error) {
    handle(res, error);
  }
};

const recordReceipt = async (req, res) => {
  try {
    await scopedRecovery(req);
    const recovery = await recoveryService.recordReceipt(req.params.id, req.body, req.user);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription:
        `Recovery received on ${recovery.reference} — now ` +
        `${money.formatMinor(recovery.recoveredMinor)} of ${money.formatMinor(recovery.recoverableMinor)}`,
      resourceType: 'Recovery',
      resourceId: recovery._id,
      statusCode: 200,
      success: true,
    });

    res.status(200).json(recovery);
  } catch (error) {
    handle(res, error);
  }
};

/**
 * Write off. Audited with the amount in the description because this is a
 * decision to stop pursuing money the insurer is owed.
 */
const writeOff = async (req, res) => {
  try {
    await scopedRecovery(req);
    const recovery = await recoveryService.writeOff(req.params.id, req.body, req.user);

    await writeAuditLog(req, {
      action: 'UPDATE',
      module: 'Legal',
      actionDescription:
        `Wrote off ${money.formatMinor(recovery.writtenOffMinor)} on ${recovery.reference} — ` +
        `${req.body.reason}`,
      resourceType: 'Recovery',
      resourceId: recovery._id,
      statusCode: 200,
      success: true,
    });

    res.status(200).json(recovery);
  } catch (error) {
    handle(res, error);
  }
};

const recordExpense = async (req, res) => {
  try {
    await scopedRecovery(req);
    res.status(200).json(await recoveryService.recordExpense(req.params.id, req.body, req.user));
  } catch (error) {
    handle(res, error);
  }
};

const position = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    res.status(200).json(await recoveryService.position({ company }));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/** Recoveries that have gone quiet — where recovery money is actually lost. */
const stale = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const items = await recoveryService.stale({
      company,
      quietDays: req.query.quietDays ? Number(req.query.quietDays) : undefined,
    });
    res.status(200).json({ count: items.length, items });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Analytics ────────────────────────────────────────────────────────────────

const courtPerformance = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    res.status(200).json(await legalAnalytics.courtPerformance({ company }));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const advocateScorecard = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    res.status(200).json(await legalAnalytics.advocateScorecard({ company }));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const reservingFeedback = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    res.status(200).json(
      await legalAnalytics.reservingFeedback({
        company,
        months: req.query.months ? Number(req.query.months) : undefined,
      })
    );
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const similarMatters = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const tpc = await ThirdPartyClaim.findById(req.params.id).select('company').lean();
    if (!tpc || !belongsToCompany(tpc.company, company)) {
      return res.status(404).json({ message: 'Third-party claim not found' });
    }
    res.status(200).json(await legalAnalytics.similarMatters(req.params.id));
  } catch (error) {
    handle(res, error);
  }
};

// ── Risk ─────────────────────────────────────────────────────────────────────

const scoreRisk = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const tpc = await ThirdPartyClaim.findById(req.params.id).select('company').lean();
    if (!tpc || !belongsToCompany(tpc.company, company)) {
      return res.status(404).json({ message: 'Third-party claim not found' });
    }
    const result = await legalRisk.score(req.params.id);
    res.status(200).json({ ...result, explanation: legalRisk.explain(result) });
  } catch (error) {
    handle(res, error);
  }
};

// ── AI assistant ─────────────────────────────────────────────────────────────

/**
 * One turn with the legal assistant.
 *
 * The caller holds the conversation and passes it back each turn; nothing is
 * persisted server-side. The tenant comes from the session, never the body — the
 * assistant's tools are scoped by it, and letting a request choose its own
 * company would make prompt injection a cross-tenant read.
 */
const askAssistant = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    if (!company) {
      return res.status(400).json({ message: 'The legal assistant is only available to insurer users' });
    }
    if (!req.body.message?.trim()) {
      return res.status(400).json({ message: 'Ask a question' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ message: 'The legal assistant is not configured in this environment' });
    }

    const result = await legalAssistant.ask({
      user: req.user,
      company,
      messages: Array.isArray(req.body.messages) ? req.body.messages : [],
      userMessage: req.body.message,
    });

    res.status(200).json({
      reply: result.reply,
      messages: result.messages,
      toolsUsed: result.toolsUsed,
      // Restated on every response so it survives being read out of context.
      disclaimer:
        'Assistant output is a draft for a Legal Officer to check. It is not legal advice and ' +
        'authorises nothing.',
    });
  } catch (error) {
    logger.error(`[legal-assistant] ${error.message}`);
    res.status(500).json({ message: 'The legal assistant could not answer that just now' });
  }
};

module.exports = {
  list,
  getById,
  create,
  chase,
  agree,
  recordReceipt,
  writeOff,
  recordExpense,
  position,
  stale,
  courtPerformance,
  advocateScorecard,
  reservingFeedback,
  similarMatters,
  scoreRisk,
  askAssistant,
};
