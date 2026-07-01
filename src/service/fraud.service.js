const Claim = require('../models/claim.model');
const logger = require('../middlewheres/logger');
const emailService = require('./email.service');

// ─── Fraud detection rules ────────────────────────────────────────────────────
// Each check returns { triggered: boolean, detail?: string }

const RULES = [
  {
    id: 'CLAIM_FREQUENCY_HIGH',
    score: 30,
    label: '3+ claims filed by the same customer in the past 90 days',
    async check(claim) {
      const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const count = await Claim.countDocuments({
        customerId: claim.customerId,
        _id: { $ne: claim._id },
        createdAt: { $gte: since },
        status: { $nin: ['Rejected'] },
      });
      return {
        triggered: count >= 2,
        detail: count >= 2 ? `${count + 1} claims in 90 days` : undefined,
      };
    },
  },
  {
    id: 'CLAIM_FREQUENCY_EXTREME',
    score: 20,
    label: '5+ claims filed by the same customer in the past 90 days',
    async check(claim) {
      const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const count = await Claim.countDocuments({
        customerId: claim.customerId,
        _id: { $ne: claim._id },
        createdAt: { $gte: since },
        status: { $nin: ['Rejected'] },
      });
      return {
        triggered: count >= 4,
        detail: count >= 4 ? `${count + 1} claims in 90 days` : undefined,
      };
    },
  },
  {
    id: 'DUPLICATE_POLICE_REPORT',
    score: 40,
    label: 'Police report number already used in another active claim',
    async check(claim) {
      const reportNumber = claim.policeReport?.reportNumber;
      if (!reportNumber) return { triggered: false };
      const existing = await Claim.findOne({
        _id: { $ne: claim._id },
        'policeReport.reportNumber': reportNumber,
        status: { $nin: ['Rejected'] },
      }).select('_id').lean();
      return {
        triggered: !!existing,
        detail: existing ? `Duplicate of claim ${existing._id}` : undefined,
      };
    },
  },
  {
    id: 'DUPLICATE_VIN',
    score: 20,
    label: 'Same vehicle (VIN) involved in another claim within 180 days',
    async check(claim) {
      const vins = (claim.vehiclesInvolved || []).map(v => v.VIN).filter(Boolean);
      if (!vins.length) return { triggered: false };
      const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
      const existing = await Claim.findOne({
        _id: { $ne: claim._id },
        'vehiclesInvolved.VIN': { $in: vins },
        createdAt: { $gte: since },
        status: { $nin: ['Rejected'] },
      }).select('_id').lean();
      return { triggered: !!existing };
    },
  },
  {
    id: 'NEAR_INCIDENT_LOCATION',
    score: 15,
    label: 'Another claim at nearly the same incident location within 30 days',
    async check(claim) {
      const { latitude, longitude } = claim.incidentDetails || {};
      if (latitude == null || longitude == null) return { triggered: false };
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      // ~0.001° ≈ 100m radius
      const existing = await Claim.findOne({
        _id: { $ne: claim._id },
        'incidentDetails.latitude': { $gte: latitude - 0.001, $lte: latitude + 0.001 },
        'incidentDetails.longitude': { $gte: longitude - 0.001, $lte: longitude + 0.001 },
        'incidentDetails.date': { $gte: since },
        status: { $nin: ['Rejected'] },
      }).select('_id').lean();
      return { triggered: !!existing };
    },
  },
  {
    id: 'REPEATED_WITNESS',
    score: 20,
    label: 'Witness contact details appear in another claim',
    async check(claim) {
      const phones = (claim.witnesses || []).map(w => w.contactInfo?.phone).filter(Boolean);
      if (!phones.length) return { triggered: false };
      const existing = await Claim.findOne({
        _id: { $ne: claim._id },
        'witnesses.contactInfo.phone': { $in: phones },
        status: { $nin: ['Rejected'] },
      }).select('_id').lean();
      return { triggered: !!existing };
    },
  },
  {
    id: 'REPEATED_DRIVER',
    score: 20,
    label: "Driver license number appears in another customer's claim",
    async check(claim) {
      const licenses = (claim.drivers || []).map(d => d.driverLicenseNumber).filter(Boolean);
      if (!licenses.length) return { triggered: false };
      const existing = await Claim.findOne({
        _id: { $ne: claim._id },
        customerId: { $ne: claim.customerId },
        'drivers.driverLicenseNumber': { $in: licenses },
        status: { $nin: ['Rejected'] },
      }).select('_id').lean();
      return { triggered: !!existing };
    },
  },
  {
    id: 'SAME_INCIDENT_DATE',
    score: 15,
    label: 'Customer filed another claim with the same incident date',
    async check(claim) {
      const date = claim.incidentDetails?.date;
      if (!date) return { triggered: false };
      const d = new Date(date);
      const dayStart = new Date(d); dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(d); dayEnd.setHours(23, 59, 59, 999);
      const existing = await Claim.findOne({
        _id: { $ne: claim._id },
        customerId: claim.customerId,
        'incidentDetails.date': { $gte: dayStart, $lte: dayEnd },
        status: { $nin: ['Rejected'] },
      }).select('_id').lean();
      return { triggered: !!existing };
    },
  },
  {
    id: 'RAPID_RESUBMISSION',
    score: 10,
    label: 'Claim resubmitted within 24 hours of a prior rejection',
    async check(claim) {
      if (claim.status !== 'Resubmitted') return { triggered: false };
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const existing = await Claim.findOne({
        customerId: claim.customerId,
        _id: { $ne: claim._id },
        status: 'Rejected',
        updatedAt: { $gte: since },
      }).select('_id').lean();
      return { triggered: !!existing };
    },
  },
];

const RISK_THRESHOLD_MEDIUM = 20;
const RISK_THRESHOLD_HIGH = 40;

const getRiskLevel = (score) => {
  if (score >= RISK_THRESHOLD_HIGH) return 'high';
  if (score >= RISK_THRESHOLD_MEDIUM) return 'medium';
  return 'low';
};

// Run all fraud rules concurrently and return { score, riskLevel, flags }
const analyseClaimFraud = async (claim) => {
  const flagged = [];
  let totalScore = 0;

  await Promise.all(
    RULES.map(async (rule) => {
      try {
        const result = await rule.check(claim);
        if (result.triggered) {
          flagged.push({
            ruleId: rule.id,
            label: result.detail ? `${rule.label} (${result.detail})` : rule.label,
            score: rule.score,
            detectedAt: new Date(),
          });
          totalScore += rule.score;
        }
      } catch (err) {
        logger.warn(`Fraud rule ${rule.id} error on claim ${claim._id}: ${err.message}`);
      }
    })
  );

  return {
    score: totalScore,
    riskLevel: getRiskLevel(totalScore),
    flags: flagged,
  };
};

// Write analysis result onto the claim object (caller must save afterwards)
const applyFraudAnalysis = (claim, analysis) => {
  if (!claim.fraud) claim.fraud = {};
  claim.fraud.riskScore = analysis.score;
  claim.fraud.riskLevel = analysis.riskLevel;
  claim.fraud.flags = analysis.flags;
  claim.fraud.lastCheckedAt = new Date();
};

// Email admin when risk is medium or high
const notifyAdminFraudAlert = async (claim, analysis) => {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return;

  try {
    const vehicle = claim.vehiclesInvolved?.[0]?.licensePlate || claim._id.toString();
    const flagList = analysis.flags.map(f => `  • ${f.label}  (+${f.score} pts)`).join('\n');

    await emailService.sendEmailNotification(
      adminEmail,
      `[AVE] Fraud Risk Alert — ${analysis.riskLevel.toUpperCase()} (Score: ${analysis.score})`,
      `A claim has been flagged with ${analysis.riskLevel.toUpperCase()} fraud risk by the automated detection system.\n\nClaim ID  : ${claim._id}\nVehicle   : ${vehicle}\nCustomer  : ${claim.claimant?.name || 'Unknown'}\nRisk Score: ${analysis.score} / 100\nRisk Level: ${analysis.riskLevel.toUpperCase()}\n\nTriggered rules:\n${flagList}\n\nPlease review this claim in the admin portal.\n\n— AVE Fraud Detection System`
    );
  } catch (err) {
    logger.warn(`Failed to send fraud alert email for claim ${claim._id}: ${err.message}`);
  }
};

module.exports = {
  analyseClaimFraud,
  applyFraudAnalysis,
  notifyAdminFraudAlert,
  RISK_THRESHOLD_HIGH,
  RISK_THRESHOLD_MEDIUM,
};
