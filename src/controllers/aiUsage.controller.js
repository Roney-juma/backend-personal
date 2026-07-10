const mongoose = require('mongoose');
const aiUsageService = require('../service/aiUsage.service');
const logger = require('../middlewheres/logger');

/**
 * GET /ai/usage/claims/:claimId
 * Full AI lifecycle cost of one claim (intake chat, photo gate, fraud pipeline,
 * continuity checks), with a per-feature/stage breakdown.
 */
const claimCost = async (req, res) => {
  try {
    const { claimId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(claimId)) {
      return res.status(400).json({ message: 'Invalid claimId' });
    }
    const report = await aiUsageService.claimLifecycleCost(claimId);
    res.status(200).json(report);
  } catch (err) {
    logger.error(`aiUsage claimCost error: ${err.message}`);
    res.status(500).json({ message: 'Could not load claim AI cost' });
  }
};

/**
 * GET /ai/usage/report?from=2026-07-01&to=2026-07-31&groupBy=day
 * groupBy: day | month | feature | model | claim
 */
const report = async (req, res) => {
  try {
    const { groupBy = 'day' } = req.query;
    const parseDate = (v, endOfDay) => {
      if (!v) return undefined;
      const d = new Date(endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T23:59:59.999Z` : v);
      if (Number.isNaN(d.getTime())) throw new Error(`Invalid date "${v}"`);
      return d;
    };
    const result = await aiUsageService.usageReport({
      from: parseDate(req.query.from, false),
      to: parseDate(req.query.to, true),
      groupBy,
    });
    res.status(200).json(result);
  } catch (err) {
    const client = /Unsupported groupBy|Invalid date/.test(err.message);
    if (!client) logger.error(`aiUsage report error: ${err.message}`);
    res.status(client ? 400 : 500).json({ message: client ? err.message : 'Could not load AI usage report' });
  }
};

module.exports = { claimCost, report };
