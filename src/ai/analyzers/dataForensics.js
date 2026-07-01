/**
 * Database / rule-based forensics analyzer.
 * Runs deterministic checks against existing claim data — no LLM, no images.
 * Wraps the rules from fraud.service.js into Signal[] format.
 * Returns { signals: Signal[], checksRun: string[] }
 */
const Claim = require('../../models/claim.model');
const logger = require('../../middlewheres/logger');

const RULES = [
  {
    id: 'claim_frequency_high',
    check: async (claim) => {
      const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const count = await Claim.countDocuments({
        customerId: claim.customerId,
        _id: { $ne: claim._id },
        createdAt: { $gte: since },
        status: { $nin: ['Rejected'] },
      });
      if (count < 2) return null;
      return {
        type: 'claim_frequency_high',
        severity: count >= 4 ? 'high' : 'medium',
        value: count + 1,
        explanation: `Customer has filed ${count + 1} claims in the last 90 days.`,
        source: 'data_forensics',
      };
    },
  },
  {
    id: 'claim_frequency_extreme',
    check: async (claim) => {
      const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const count = await Claim.countDocuments({
        customerId: claim.customerId,
        _id: { $ne: claim._id },
        createdAt: { $gte: since },
        status: { $nin: ['Rejected'] },
      });
      if (count < 4) return null;
      return {
        type: 'claim_frequency_extreme',
        severity: 'high',
        value: count + 1,
        explanation: `Customer has filed ${count + 1} claims in the last 90 days — extreme frequency.`,
        source: 'data_forensics',
      };
    },
  },
  {
    id: 'duplicate_police_report',
    check: async (claim) => {
      const reportNumber = claim.policeReport?.reportNumber;
      if (!reportNumber) return null;
      const existing = await Claim.findOne({
        _id: { $ne: claim._id },
        'policeReport.reportNumber': reportNumber,
        status: { $nin: ['Rejected'] },
      }).select('_id').lean();
      if (!existing) return null;
      return {
        type: 'duplicate_police_report',
        severity: 'high',
        evidence: reportNumber,
        explanation: `Police report number "${reportNumber}" was already used in claim ${existing._id}.`,
        source: 'data_forensics',
      };
    },
  },
  {
    id: 'duplicate_vin',
    check: async (claim) => {
      const vins = (claim.vehiclesInvolved || []).map(v => v.VIN).filter(Boolean);
      if (!vins.length) return null;
      const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
      const existing = await Claim.findOne({
        _id: { $ne: claim._id },
        'vehiclesInvolved.VIN': { $in: vins },
        createdAt: { $gte: since },
        status: { $nin: ['Rejected'] },
      }).select('_id').lean();
      if (!existing) return null;
      return {
        type: 'duplicate_vin',
        severity: 'medium',
        evidence: vins.join(', '),
        explanation: `Vehicle VIN ${vins[0]} appears in another claim within the last 180 days.`,
        source: 'data_forensics',
      };
    },
  },
  {
    id: 'near_incident_location',
    check: async (claim) => {
      const { latitude, longitude } = claim.incidentDetails || {};
      if (latitude == null || longitude == null) return null;
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const existing = await Claim.findOne({
        _id: { $ne: claim._id },
        'incidentDetails.latitude': { $gte: latitude - 0.001, $lte: latitude + 0.001 },
        'incidentDetails.longitude': { $gte: longitude - 0.001, $lte: longitude + 0.001 },
        'incidentDetails.date': { $gte: since },
        status: { $nin: ['Rejected'] },
      }).select('_id').lean();
      if (!existing) return null;
      return {
        type: 'near_incident_location',
        severity: 'medium',
        explanation: 'Another claim was filed at nearly the same location within the past 30 days.',
        source: 'data_forensics',
      };
    },
  },
  {
    id: 'repeated_witness',
    check: async (claim) => {
      const phones = (claim.witnesses || []).map(w => w.contactInfo?.phone).filter(Boolean);
      if (!phones.length) return null;
      const existing = await Claim.findOne({
        _id: { $ne: claim._id },
        'witnesses.contactInfo.phone': { $in: phones },
        status: { $nin: ['Rejected'] },
      }).select('_id').lean();
      if (!existing) return null;
      return {
        type: 'repeated_witness',
        severity: 'medium',
        explanation: 'A witness phone number from this claim appears in another claim.',
        source: 'data_forensics',
      };
    },
  },
  {
    id: 'repeated_driver',
    check: async (claim) => {
      const licenses = (claim.drivers || []).map(d => d.driverLicenseNumber).filter(Boolean);
      if (!licenses.length) return null;
      const existing = await Claim.findOne({
        _id: { $ne: claim._id },
        customerId: { $ne: claim.customerId },
        'drivers.driverLicenseNumber': { $in: licenses },
        status: { $nin: ['Rejected'] },
      }).select('_id').lean();
      if (!existing) return null;
      return {
        type: 'repeated_driver',
        severity: 'medium',
        evidence: licenses[0],
        explanation: `Driver license ${licenses[0]} appears in a different customer's claim.`,
        source: 'data_forensics',
      };
    },
  },
  {
    id: 'same_incident_date',
    check: async (claim) => {
      const date = claim.incidentDetails?.date;
      if (!date) return null;
      const d = new Date(date);
      const dayStart = new Date(d); dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(d); dayEnd.setHours(23, 59, 59, 999);
      const existing = await Claim.findOne({
        _id: { $ne: claim._id },
        customerId: claim.customerId,
        'incidentDetails.date': { $gte: dayStart, $lte: dayEnd },
        status: { $nin: ['Rejected'] },
      }).select('_id').lean();
      if (!existing) return null;
      return {
        type: 'same_incident_date',
        severity: 'medium',
        explanation: 'Customer has another claim with the same incident date.',
        source: 'data_forensics',
      };
    },
  },
  {
    id: 'rapid_resubmission',
    check: async (claim) => {
      if (claim.status !== 'Resubmitted') return null;
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const existing = await Claim.findOne({
        customerId: claim.customerId,
        _id: { $ne: claim._id },
        status: 'Rejected',
        updatedAt: { $gte: since },
      }).select('_id').lean();
      if (!existing) return null;
      return {
        type: 'rapid_resubmission',
        severity: 'low',
        explanation: 'Claim was resubmitted within 24 hours of a rejection.',
        source: 'data_forensics',
      };
    },
  },
];

const run = async (claim) => {
  const signals = [];
  const checksRun = [];

  await Promise.all(RULES.map(async (rule) => {
    checksRun.push(rule.id);
    try {
      const sig = await rule.check(claim);
      if (sig) signals.push(sig);
    } catch (err) {
      logger.warn(`[dataForensics] rule ${rule.id} failed for claim ${claim._id}: ${err.message}`);
    }
  }));

  return { signals, checksRun };
};

module.exports = { run };
