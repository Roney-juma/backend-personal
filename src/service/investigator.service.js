const crypto = require('crypto');
const Investigator = require('../models/investigator.model');
const Investigation = require('../models/investigation.model');
const Claim = require('../models/claim.model');
const ApiError = require('../utils/ApiError');
const emailService = require('./email.service');
const whatsappService = require('./whatsapp.service');
const notificationService = require('./notification.service');
const { writeAuditLog } = require('../utils/auditHelper');

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://avics.aveafrica.com';

// ─── Investigator CRUD (admin-managed) ───────────────────────────────────────

const createInvestigator = async (data, req) => {
  const existing = await Investigator.findOne({ email: data.email });
  if (existing) throw new ApiError(409, 'Investigator already exists with this email');

  const start = Date.now();
  const investigator = await Investigator.create(data);

  await emailService.sendEmailNotification(
    investigator.email,
    'Welcome to AVE Insurance — Investigator Account',
    `Dear ${investigator.name},\n\nYour investigator profile has been registered on the AVE Insurance platform.\n\nWhen you are assigned to a claim, you will receive a secure link via email to access the claim details and submit your investigation report. No login is required.\n\nRegards,\nThe AVE Insurance Team`
  );
  if (investigator.contactNumber) {
    await whatsappService.sendWhatsAppMessage(
      investigator.contactNumber,
      `Hi ${investigator.name}, your investigator profile has been registered on AVE Insurance. You'll receive claim assignments with a secure link via email. — Ave Insurance`
    );
  }

  await writeAuditLog(req, {
    action: 'CREATE',
    module: 'Investigator',
    actionDescription: `Created investigator account for ${investigator.email}`,
    resourceType: 'Investigator',
    resourceId: investigator._id,
    statusCode: 201,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: null, new: data },
  });

  return investigator;
};

const getAllInvestigators = async (filter = {}, page = 1, limit = 10) => {
  const query = {};
  if (filter.city) query['location.city'] = new RegExp(filter.city, 'i');
  if (filter.specialization) query.specializations = filter.specialization;
  if (filter.name) query.name = new RegExp(filter.name, 'i');

  const skip = (page - 1) * limit;
  const [investigators, total] = await Promise.all([
    Investigator.find(query).skip(skip).limit(Number(limit)).sort({ createdAt: -1 }),
    Investigator.countDocuments(query),
  ]);

  return { investigators, total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) };
};

const getInvestigatorById = async (id) => {
  const investigator = await Investigator.findById(id);
  if (!investigator) throw new ApiError(404, 'Investigator not found');
  return investigator;
};

const updateInvestigator = async (id, data, req) => {
  const investigator = await Investigator.findById(id);
  if (!investigator) throw new ApiError(404, 'Investigator not found');

  const start = Date.now();
  const oldData = investigator.toObject();
  const updated = await Investigator.findByIdAndUpdate(id, data, { new: true });

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Investigator',
    actionDescription: `Updated investigator profile (ID: ${id})`,
    resourceType: 'Investigator',
    resourceId: id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: oldData, new: data },
  });

  return updated;
};

const deleteInvestigator = async (id, req) => {
  const investigator = await Investigator.findById(id);
  if (!investigator) throw new ApiError(404, 'Investigator not found');

  const snapshot = investigator.toObject();
  const start = Date.now();
  await Investigator.findByIdAndDelete(id);

  await writeAuditLog(req, {
    action: 'DELETE',
    module: 'Investigator',
    actionDescription: `Deleted investigator account for ${snapshot.email} (ID: ${id})`,
    resourceType: 'Investigator',
    resourceId: id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: snapshot, new: null },
  });
};

const getInvestigatorStats = async () => {
  const total = await Investigator.countDocuments();
  const active = await Investigator.countDocuments({ pendingInvestigations: { $gt: 0 } });
  const activeInvestigations = await Investigation.countDocuments({ status: { $in: ['Pending', 'Appointed', 'In Progress'] } });
  const submitted = await Investigation.countDocuments({ status: 'Submitted' });
  return { total, active, idle: total - active, activeInvestigations, awaitingReview: submitted };
};

// ─── Investigation workflow ───────────────────────────────────────────────────

// Step 1 — Insurance company flags a claim as suspected fraud and opens an investigation
const flagClaimAsFraud = async (claimId, reason, flaggedBy, flaggedByType, req) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new ApiError(404, 'Claim not found');

  if (!['Assessed', 'Approved', 'Garage'].includes(claim.status)) {
    throw new ApiError(400, 'A fraud flag can only be raised after the assessment report is submitted (claim status must be Assessed, Approved, or Garage)');
  }

  const existing = await Investigation.findOne({ claimId, status: { $nin: ['Reviewed'] } });
  if (existing) throw new ApiError(400, 'An active investigation already exists for this claim');

  const start = Date.now();
  const previousStatus = claim.status;

  const investigation = await Investigation.create({
    claimId,
    flaggedBy,
    flaggedByType,
    reason,
    status: 'Pending',
    supportingDocuments: claim.supportingDocuments,
    assessmentReport: claim.assessmentReport,
  });

  claim.fraud = {
    suspected: true,
    investigationId: investigation._id,
  };
  claim.status = 'UnderInvestigation';
  await claim.save();

  // Notify customer
  if (claim.customerId) {
    await notificationService.createAndEmit({
      recipientId: claim.customerId,
      recipientType: 'customer',
      type: 'investigation_assigned',
      title: 'Claim Under Investigation',
      content: 'Your claim has been flagged for further investigation by your insurance provider. We will notify you once the review is complete.',
      claimId,
    });
  }

  // Email + WhatsApp customer
  if (claim.claimant && claim.claimant.email) {
    await emailService.sendEmailNotification(
      claim.claimant.email,
      'Important: Your Claim Is Under Investigation',
      `Dear ${claim.claimant.name || 'Valued Customer'},

We are writing to inform you that your insurance claim (Vehicle: ${claim.vehiclesInvolved?.[0]?.licensePlate || claimId}) has been flagged for further investigation by your insurance provider.

What this means:
- A qualified investigator will be appointed to review your claim shortly.
- This is a standard part of our claims process to ensure accuracy and fairness.
- No action is required from you at this time.

You will receive a follow-up notification once the investigation has been completed.

If you have any questions, please contact your insurance provider directly.

Regards,
The AVE Insurance Team`
    );
  }
  if (claim.claimant && claim.claimant.phone) {
    await whatsappService.sendWhatsAppMessage(
      claim.claimant.phone,
      `Hi ${claim.claimant.name || 'Valued Customer'}, your claim (Vehicle: ${claim.vehiclesInvolved?.[0]?.licensePlate || claimId}) has been flagged for investigation. No action is needed from you now — we'll keep you updated. — Ave Insurance`
    );
  }

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Flagged claim ${claimId} as suspected fraud — investigation opened`,
    resourceType: 'Claim',
    resourceId: claimId,
    statusCode: 201,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: previousStatus }, new: { status: 'UnderInvestigation', investigationId: investigation._id } },
  });

  return investigation;
};

// Step 2 — Appoint an investigator to an existing (Pending) investigation and send them the secure link
const appointInvestigator = async (investigationId, investigatorId, req) => {
  const investigation = await Investigation.findById(investigationId).populate('claimId');
  if (!investigation) throw new ApiError(404, 'Investigation not found');
  if (investigation.status !== 'Pending') throw new ApiError(400, 'An investigator can only be appointed to a Pending investigation');
  if (investigation.investigatorId) throw new ApiError(400, 'An investigator has already been appointed to this investigation');

  const investigator = await Investigator.findById(investigatorId);
  if (!investigator) throw new ApiError(404, 'Investigator not found');

  const start = Date.now();
  const claim = investigation.claimId;

  const accessToken = crypto.randomBytes(32).toString('hex');
  const investigationLink = `${FRONTEND_URL}/investigators/report/token=${accessToken}`;

  investigation.investigatorId = investigatorId;
  investigation.appointedAt = new Date();
  investigation.accessToken = accessToken;
  investigation.status = 'Appointed';

  // Update fraud sub-doc on claim with the appointed investigator
  await Claim.findByIdAndUpdate(claim._id, {
    'fraud.awardedInvestigator': { investigatorId, assignedDate: new Date() },
  });

  await investigation.save();

  investigator.pendingInvestigations += 1;
  await investigator.save();

  const claimant = claim.claimant || {};

  const invVehicle = claim.vehiclesInvolved?.[0]?.licensePlate || 'N/A';

  // Email investigator with secure link + customer contact details
  await emailService.sendEmailNotification(
    investigator.email,
    'Investigation Appointment — Action Required',
    `Dear ${investigator.name},

You have been appointed to investigate the following insurance claim.

Claim ID:   ${claim._id}
Vehicle:    ${invVehicle} — ${claim.vehiclesInvolved?.[0]?.make || ''} ${claim.vehiclesInvolved?.[0]?.model || ''}
Reason:     ${investigation.reason}

── Customer Contact Details ──────────────────────
Name:       ${claimant.name || 'N/A'}
Email:      ${claimant.email || 'N/A'}
Phone:      ${claimant.phone || 'N/A'}
Address:    ${claimant.address || 'N/A'}
─────────────────────────────────────────────────

Please contact the customer directly to arrange your investigation.

To access the full claim details and submit your investigation report, click the secure link below:

${investigationLink}

This link is unique to this investigation and can only be used once. Please do not share it.

Regards,
The AVE Insurance Team`
  );
  if (investigator.contactNumber) {
    await whatsappService.sendWhatsAppMessage(
      investigator.contactNumber,
      `Hi ${investigator.name}, you've been *appointed* to investigate claim ${invVehicle}.\n\nCustomer: ${claimant.name || 'N/A'} | ${claimant.phone || 'N/A'}\n\nYour secure report link has been sent to your email. — Ave Insurance`
    );
  }

  // Email + WhatsApp customer with investigator details
  if (claimant.email) {
    await emailService.sendEmailNotification(
      claimant.email,
      'Investigator Appointed to Your Claim',
      `Dear ${claimant.name || 'Valued Customer'},

An investigator has been appointed to review your insurance claim (Vehicle: ${invVehicle}).

── Appointed Investigator ────────────────────────
Name:       ${investigator.name}
Email:      ${investigator.email}
Phone:      ${investigator.contactNumber}
${investigator.licenseNumber ? `License No: ${investigator.licenseNumber}` : ''}
─────────────────────────────────────────────────

The investigator will reach out to you via email or phone to schedule a review. Please provide all necessary supporting documents and cooperate fully with the investigator to enable a quick closure of your claim.

If you have not been contacted within 3 business days, please contact your insurance provider.

Regards,
The AVE Insurance Team`
    );
  }
  if (claimant.phone) {
    await whatsappService.sendWhatsAppMessage(
      claimant.phone,
      `Hi ${claimant.name || 'Valued Customer'}, an investigator has been appointed to your claim (${invVehicle}).\n\nInvestigator: ${investigator.name}\nPhone: ${investigator.contactNumber}\nEmail: ${investigator.email}\n\nThey will contact you within 3 business days. — Ave Insurance`
    );
  }

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Investigation',
    actionDescription: `Appointed investigator ${investigatorId} to investigation ${investigationId}`,
    resourceType: 'Investigation',
    resourceId: investigationId,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: 'Pending', investigatorId: null }, new: { status: 'Appointed', investigatorId } },
  });

  return investigation;
};

// Investigator opens the link — returns claim + investigation details and auto-starts the investigation
const getInvestigationByToken = async (token) => {
  const investigation = await Investigation.findOne({ accessToken: token })
    .populate('claimId')
    .populate('investigatorId', 'name email contactNumber licenseNumber specializations');

  if (!investigation) throw new ApiError(404, 'Invalid investigation link');
  if (investigation.tokenUsed) throw new ApiError(400, 'This investigation link has already been used to submit a report');
  if (investigation.status === 'Reviewed') throw new ApiError(400, 'This investigation has already been reviewed');

  // Auto-transition Appointed → In Progress on first visit
  if (investigation.status === 'Appointed') {
    investigation.status = 'In Progress';
    await investigation.save();
  }

  return investigation;
};

// Investigator submits their report — identified by investigationId, verified by token from the email link
const submitInvestigationReport = async (investigationId, token, report, req) => {
  const investigation = await Investigation.findById(investigationId);
  if (!investigation) throw new ApiError(404, 'Investigation not found');
  if (!investigation.accessToken || investigation.accessToken !== token) throw new ApiError(403, 'Invalid or mismatched access token');
  if (investigation.tokenUsed) throw new ApiError(400, 'Report has already been submitted for this investigation');
  if (!['Appointed', 'In Progress'].includes(investigation.status)) {
    throw new ApiError(400, 'This investigation is no longer open for report submission');
  }

  const start = Date.now();

  investigation.report = {
    findings: report.findings,
    conclusion: report.conclusion,
    evidence: report.evidence || [],
    comprehensiveReport: report.comprehensiveReport || '',
    submittedAt: new Date(),
  };
  investigation.status = 'Submitted';
  investigation.tokenUsed = true;
  await investigation.save();

  const claim = await Claim.findById(investigation.claimId);
  if (claim) {
    claim.status = 'Investigated';
    await claim.save();
  }

  await Investigator.findByIdAndUpdate(investigation.investigatorId, {
    $inc: { pendingInvestigations: -1 },
  });

  // Notify admin/insurance company who flagged the claim
  await notificationService.createAndEmit({
    recipientId: investigation.flaggedBy,
    recipientType: 'admin',
    type: 'investigation_submitted',
    title: 'Investigation Report Submitted',
    content: `The investigation report for claim #${investigation.claimId} has been submitted. Investigator conclusion: ${report.conclusion}. Please review and make a final decision.`,
    claimId: investigation.claimId,
  });

  // Notify customer
  if (claim?.customerId) {
    await notificationService.createAndEmit({
      recipientId: claim.customerId,
      recipientType: 'customer',
      type: 'investigation_completed',
      title: 'Investigation Complete',
      content: 'The investigation into your claim has been completed. Your insurance provider will review the findings and update you shortly.',
      claimId: investigation.claimId,
    });
  }

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Investigation',
    actionDescription: `Investigator submitted report via secure link for investigation ${investigation._id}`,
    resourceType: 'Investigation',
    resourceId: investigation._id,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: 'In Progress' }, new: { status: 'Submitted', conclusion: report.conclusion } },
  });

  return investigation;
};

// Admin makes the final decision on a claim after reviewing the investigation report
// decision: 'reject' | 'clear' | 'inconclusive'
const reviewInvestigationReport = async (investigationId, decision, reviewNotes, reviewedBy, req) => {
  const investigation = await Investigation.findById(investigationId);
  if (!investigation) throw new ApiError(404, 'Investigation not found');
  if (investigation.status !== 'Submitted') throw new ApiError(400, 'Only submitted investigations can have a final decision recorded');
  if (!['reject', 'clear', 'inconclusive'].includes(decision)) {
    throw new ApiError(400, 'decision must be one of: reject, clear, inconclusive');
  }

  const claim = await Claim.findById(investigation.claimId);
  const previousClaimStatus = claim?.status;
  const vehicle = claim?.vehiclesInvolved?.[0]?.licensePlate || String(investigation.claimId);
  const customerName = claim?.claimant?.name || 'Valued Customer';

  let newClaimStatus;
  let notificationTitle;
  let notificationContent;
  let emailSubject;
  let emailBody;

  if (decision === 'reject') {
    newClaimStatus = 'Rejected';
    notificationTitle = 'Claim Rejected';
    notificationContent = 'Your insurance claim has been rejected following a fraud investigation. Please contact your insurance provider if you wish to appeal this decision.';
    emailSubject = 'Claim Rejected — Final Decision';
    emailBody = `Dear ${customerName},

We regret to inform you that your insurance claim (Vehicle: ${vehicle}) has been rejected following a fraud investigation.

Decision: Claim Rejected
Reason:   ${reviewNotes || 'Fraudulent activity was identified during the investigation process.'}

If you believe this decision is incorrect, you have the right to appeal. Please contact your insurance provider within 30 days of receiving this notice.

Regards,
The AVE Insurance Team`;
  } else if (decision === 'clear') {
    newClaimStatus = 'Assessed';
    notificationTitle = 'Claim Cleared — Investigation Complete';
    notificationContent = 'Your claim has been reviewed and cleared following the fraud investigation. Your claim will now continue through the normal process.';
    emailSubject = 'Good News — Your Claim Has Been Cleared';
    emailBody = `Dear ${customerName},

We are pleased to inform you that your insurance claim (Vehicle: ${vehicle}) has been reviewed and cleared following the fraud investigation.

Your claim will now continue through the normal claims process. You will receive further updates as your claim progresses.

We apologise for any inconvenience caused by this review.

Regards,
The AVE Insurance Team`;
  } else {
    newClaimStatus = 'Investigated';
    notificationTitle = 'Claim Update — Further Review Required';
    notificationContent = 'Your insurance provider requires additional information before a final decision can be made on your claim. You will be contacted shortly.';
    emailSubject = 'Claim Update — Further Review Required';
    emailBody = `Dear ${customerName},

Your insurance claim (Vehicle: ${vehicle}) requires further review before a final decision can be made.

${reviewNotes ? `Note: ${reviewNotes}\n\n` : ''}Your insurance provider will be in touch shortly. No action is required from you at this time.

Regards,
The AVE Insurance Team`;
  }

  const start = Date.now();

  investigation.reviewNotes = reviewNotes;
  investigation.reviewedAt = new Date();
  investigation.reviewedBy = reviewedBy;
  investigation.status = 'Reviewed';
  await investigation.save();

  if (claim) {
    if (decision === 'reject') {
      claim.rejectionReason = reviewNotes || 'Claim rejected following fraud investigation';
    }
    claim.status = newClaimStatus;
    await claim.save();
  }

  if (claim?.customerId) {
    await notificationService.createAndEmit({
      recipientId: claim.customerId,
      recipientType: 'customer',
      type: 'investigation_completed',
      title: notificationTitle,
      content: notificationContent,
      claimId: investigation.claimId,
    });
  }

  if (claim?.claimant?.email) {
    await emailService.sendEmailNotification(claim.claimant.email, emailSubject, emailBody);
  }
  if (claim?.claimant?.phone) {
    const waDecision = decision === 'reject'
      ? `Hi ${customerName}, your claim (${vehicle}) has been *rejected* following a fraud investigation. Reason: ${reviewNotes || 'Fraudulent activity identified'}. Contact your insurer to appeal within 30 days.`
      : decision === 'clear'
      ? `Hi ${customerName}, great news! Your claim (${vehicle}) has been *cleared* after investigation and will continue through the normal process. — Ave Insurance`
      : `Hi ${customerName}, your claim (${vehicle}) requires further review. Your insurer will be in touch shortly. — Ave Insurance`;
    await whatsappService.sendWhatsAppMessage(claim.claimant.phone, waDecision);
  }

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Investigation',
    actionDescription: `Admin made final decision on investigation ${investigationId} — decision: ${decision}, claim status → ${newClaimStatus}`,
    resourceType: 'Investigation',
    resourceId: investigationId,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: {
      old: { investigationStatus: 'Submitted', claimStatus: previousClaimStatus },
      new: { investigationStatus: 'Reviewed', claimStatus: newClaimStatus, decision, reviewNotes },
    },
  });

  return { investigation, claimStatus: newClaimStatus, decision };
};

const getMyInvestigations = async (investigatorId) => {
  const investigations = await Investigation.find({ investigatorId })
    .populate('claimId', 'status incidentDetails vehiclesInvolved claimant customerId')
    .sort({ createdAt: -1 });

  if (!investigations.length) throw new ApiError(404, 'No investigations found for this investigator');
  return investigations;
};

const getAllInvestigations = async () => {
  return Investigation.find()
    .populate('claimId', 'status incidentDetails vehiclesInvolved claimant')
    .populate('investigatorId', 'name email contactNumber')
    .sort({ createdAt: -1 });
};

const getInvestigationById = async (id) => {
  const investigation = await Investigation.findById(id)
    .populate('claimId')
    .populate('investigatorId', 'name email contactNumber licenseNumber');
  if (!investigation) throw new ApiError(404, 'Investigation not found');
  return investigation;
};

module.exports = {
  createInvestigator,
  getAllInvestigators,
  getInvestigatorById,
  updateInvestigator,
  deleteInvestigator,
  getInvestigatorStats,
  flagClaimAsFraud,
  appointInvestigator,
  getInvestigationByToken,
  submitInvestigationReport,
  reviewInvestigationReport,
  getMyInvestigations,
  getAllInvestigations,
  getInvestigationById,
};
