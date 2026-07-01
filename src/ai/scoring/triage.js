const Claim = require('../../models/claim.model');
const emailService = require('../../service/email.service');
const logger = require('../../middlewheres/logger');

/**
 * Route a claim by risk band — flag + notify, never auto-decide or change claim.status.
 * Spec §8: "No auto-approval, no auto-status-change."
 */
const route = async (claim, band, analysis) => {
  const vehicle = claim.vehiclesInvolved?.[0]?.licensePlate || String(claim._id);
  const adminEmail = process.env.ADMIN_EMAIL;

  if (band === 'high') {
    // Set fraud.suspected so the admin dashboard can surface it immediately
    await Claim.findByIdAndUpdate(claim._id, { 'fraud.suspected': true });

    logger.warn(`[fraud] HIGH risk claim ${claim._id} (score ${analysis.score}) — fraud.suspected set`);

    if (adminEmail) {
      const flagList = analysis.signals
        .map(s => `  • ${s.type} (${s.severity}): ${s.explanation || ''}`)
        .join('\n');

      await emailService.sendEmailNotification(
        adminEmail,
        `[AVE] HIGH Fraud Risk — Claim ${vehicle} (Score: ${analysis.score}/100)`,
        `A claim has been flagged as HIGH fraud risk by the automated pipeline.\n\nClaim ID  : ${claim._id}\nVehicle   : ${vehicle}\nCustomer  : ${claim.claimant?.name || 'Unknown'}\nScore     : ${analysis.score}/100\n\nReasoning :\n${analysis.reasoning}\n\nSignals   :\n${flagList}\n\nAction required: Review this claim and consider opening a formal investigation.\n\n— AVE Fraud Intelligence System`
      ).catch(err => logger.warn(`[fraud] email failed: ${err.message}`));
    }
  } else if (band === 'medium') {
    logger.info(`[fraud] MEDIUM risk claim ${claim._id} (score ${analysis.score}) — admin notified`);

    if (adminEmail) {
      await emailService.sendEmailNotification(
        adminEmail,
        `[AVE] MEDIUM Fraud Risk — Claim ${vehicle} (Score: ${analysis.score}/100)`,
        `A claim has been flagged with MEDIUM fraud risk.\n\nClaim ID  : ${claim._id}\nVehicle   : ${vehicle}\nCustomer  : ${claim.claimant?.name || 'Unknown'}\nScore     : ${analysis.score}/100\n\nReasoning :\n${analysis.reasoning}\n\nReview recommended before approval.\n\n— AVE Fraud Intelligence System`
      ).catch(err => logger.warn(`[fraud] email failed: ${err.message}`));
    }
  }
  // low — no action beyond persisting the score
};

module.exports = { route };
