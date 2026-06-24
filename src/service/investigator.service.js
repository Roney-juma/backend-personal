const crypto = require('crypto');
const Investigator = require('../models/investigator.model');
const Investigation = require('../models/investigation.model');
const Claim = require('../models/claim.model');
const ApiError = require('../utils/ApiError');
const emailService = require('./email.service');
const notificationService = require('./notification.service');
const { writeAuditLog } = require('../utils/auditHelper');

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:4200';

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
  const activeInvestigations = await Investigation.countDocuments({ status: { $in: ['Pending', 'In Progress'] } });
  const submitted = await Investigation.countDocuments({ status: 'Submitted' });
  return { total, active, idle: total - active, activeInvestigations, awaitingReview: submitted };
};

// ─── Investigation workflow ───────────────────────────────────────────────────

// Insurance company assigns an investigator to a claim and emails them a secure link
const assignInvestigator = async (claimId, investigatorId, reason, assignedBy, assignedByType, req) => {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new ApiError(404, 'Claim not found');

  if (!['Assessed', 'Approved', 'Garage'].includes(claim.status)) {
    throw new ApiError(400, 'Investigation can only be initiated after assessment report is submitted (claim status: Assessed, Approved, or Garage)');
  }

  const investigator = await Investigator.findById(investigatorId);
  if (!investigator) throw new ApiError(404, 'Investigator not found');

  const existing = await Investigation.findOne({ claimId, status: { $in: ['Pending', 'In Progress'] } });
  if (existing) throw new ApiError(400, 'An active investigation already exists for this claim');

  const start = Date.now();

  // Generate a secure, single-use token for this investigation
  const accessToken = crypto.randomBytes(32).toString('hex');
  const investigationLink = `${FRONTEND_URL}/investigate?token=${accessToken}`;

  const investigation = await Investigation.create({
    claimId,
    investigatorId,
    assignedBy,
    assignedByType,
    reason,
    status: 'Pending',
    accessToken,
  });

  const previousStatus = claim.status;
  claim.fraud = {
    suspected: true,
    investigationId: investigation._id,
    awardedInvestigator: { investigatorId, assignedDate: new Date() },
  };
  claim.status = 'UnderInvestigation';
  await claim.save();

  investigator.pendingInvestigations += 1;
  await investigator.save();

  // Notify investigator via socket (in case they're on the admin portal)
  await notificationService.createAndEmit({
    recipientId: investigatorId,
    recipientType: 'investigator',
    type: 'investigation_assigned',
    title: 'New Investigation Assigned',
    content: `You have been assigned to investigate claim #${claimId}. Check your email for the secure access link.`,
    claimId,
  });

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

  // Email investigator with secure link
  await emailService.sendEmailNotification(
    investigator.email,
    'Investigation Assignment — Action Required',
    `Dear ${investigator.name},

You have been appointed to investigate the following insurance claim.

Claim ID:   ${claimId}
Vehicle:    ${claim.vehiclesInvolved?.[0]?.licensePlate || 'N/A'} — ${claim.vehiclesInvolved?.[0]?.make || ''} ${claim.vehiclesInvolved?.[0]?.model || ''}
Reason:     ${reason}

To access the claim details and submit your investigation report, please click the secure link below:

${investigationLink}

This link is unique to this investigation. Please do not share it.

Regards,
The AVE Insurance Team`
  );

  // Email customer — fraud detected notification
  if (claim.claimant && claim.claimant.email) {
    await emailService.sendEmailNotification(
      claim.claimant.email,
      'Important: Your Claim Is Under Investigation',
      `Dear ${claim.claimant.name || 'Valued Customer'},

We are writing to inform you that your insurance claim (Vehicle: ${claim.vehiclesInvolved?.[0]?.licensePlate || claimId}) has been flagged for further investigation by your insurance provider.

What this means:
- A qualified investigator has been assigned to review your claim.
- This is a standard part of our claims process to ensure accuracy and fairness.
- No action is required from you at this time.

You will receive a follow-up notification once the investigation has been completed.

If you have any questions, please contact your insurance provider directly.

Regards,
The AVE Insurance Team`
    );
  }

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Claim',
    actionDescription: `Assigned investigator ${investigatorId} to claim ${claimId} for suspected fraud`,
    resourceType: 'Claim',
    resourceId: claimId,
    statusCode: 201,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: previousStatus }, new: { status: 'UnderInvestigation', investigationId: investigation._id } },
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

  // Auto-transition Pending → In Progress on first visit
  if (investigation.status === 'Pending') {
    investigation.status = 'In Progress';
    await investigation.save();
  }

  return investigation;
};

// Investigator submits their report via the secure token link
const submitInvestigationReport = async (token, report, req) => {
  const investigation = await Investigation.findOne({ accessToken: token });
  if (!investigation) throw new ApiError(404, 'Invalid investigation link');
  if (investigation.tokenUsed) throw new ApiError(400, 'Report has already been submitted via this link');
  if (!['Pending', 'In Progress'].includes(investigation.status)) {
    throw new ApiError(400, 'This investigation is no longer open for report submission');
  }

  const start = Date.now();

  investigation.report = {
    findings: report.findings,
    conclusion: report.conclusion,
    evidence: report.evidence || [],
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

  // Notify admin/insurance company
  await notificationService.createAndEmit({
    recipientId: investigation.assignedBy,
    recipientType: 'admin',
    type: 'investigation_submitted',
    title: 'Investigation Report Submitted',
    content: `The investigation report for claim #${investigation.claimId} has been submitted. Conclusion: ${report.conclusion}`,
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

// Admin/insurance reviews submitted report — claim status driven by conclusion
const reviewInvestigationReport = async (investigationId, reviewNotes, reviewedBy, req) => {
  const investigation = await Investigation.findById(investigationId);
  if (!investigation) throw new ApiError(404, 'Investigation not found');
  if (investigation.status !== 'Submitted') throw new ApiError(400, 'Only submitted investigations can be reviewed');

  const conclusion = investigation.report?.conclusion;
  if (!conclusion) throw new ApiError(400, 'Investigation report has no conclusion recorded');

  const start = Date.now();
  investigation.reviewNotes = reviewNotes;
  investigation.reviewedAt = new Date();
  investigation.reviewedBy = reviewedBy;
  investigation.status = 'Reviewed';
  await investigation.save();

  const claim = await Claim.findById(investigation.claimId);
  const previousClaimStatus = claim?.status;
  let newClaimStatus;
  let notificationTitle;
  let notificationContent;
  let emailSubject;
  let emailBody;

  if (conclusion === 'Fraud Confirmed') {
    newClaimStatus = 'Rejected';
    notificationTitle = 'Claim Rejected — Fraud Detected';
    notificationContent = 'Following a thorough investigation, your insurance claim has been rejected due to confirmed fraudulent activity. Please contact your insurance provider if you wish to appeal this decision.';
    emailSubject = 'Claim Rejected — Fraud Investigation Outcome';
    emailBody = `Dear ${claim?.claimant?.name || 'Valued Customer'},

We regret to inform you that your insurance claim (Vehicle: ${claim?.vehiclesInvolved?.[0]?.licensePlate || investigation.claimId}) has been rejected following a fraud investigation.

Reason: ${reviewNotes || 'Fraudulent activity was confirmed during the investigation process.'}

If you believe this decision is incorrect, you have the right to appeal. Please contact your insurance provider within 30 days of receiving this notice.

Regards,
The AVE Insurance Team`;
  } else if (conclusion === 'Fraud Not Found') {
    newClaimStatus = 'Assessed';
    notificationTitle = 'Claim Cleared — Investigation Complete';
    notificationContent = 'The investigation into your claim has found no evidence of fraud. Your claim will now continue through the normal assessment process.';
    emailSubject = 'Good News — Your Claim Has Been Cleared';
    emailBody = `Dear ${claim?.claimant?.name || 'Valued Customer'},

We are pleased to inform you that the investigation into your insurance claim (Vehicle: ${claim?.vehiclesInvolved?.[0]?.licensePlate || investigation.claimId}) has been completed and no fraud was found.

Your claim will now continue through the normal claims process. You will receive further updates as your claim progresses.

We apologise for any inconvenience caused by this review.

Regards,
The AVE Insurance Team`;
  } else {
    // Inconclusive — stays at Investigated; admin must decide next step manually
    newClaimStatus = 'Investigated';
    notificationTitle = 'Investigation Update — Further Review Required';
    notificationContent = 'The investigation into your claim returned an inconclusive result. Your insurance provider is conducting a further review and will be in touch shortly.';
    emailSubject = 'Claim Update — Further Review Required';
    emailBody = `Dear ${claim?.claimant?.name || 'Valued Customer'},

The investigation into your insurance claim (Vehicle: ${claim?.vehiclesInvolved?.[0]?.licensePlate || investigation.claimId}) has returned an inconclusive result.

Your insurance provider is conducting a further review. No action is required from you at this time. We will notify you once a final decision has been reached.

Regards,
The AVE Insurance Team`;
  }

  if (claim) {
    if (conclusion === 'Fraud Confirmed') {
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

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Investigation',
    actionDescription: `Investigation ${investigationId} reviewed — conclusion: ${conclusion}, claim status → ${newClaimStatus}`,
    resourceType: 'Investigation',
    resourceId: investigationId,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: {
      old: { investigationStatus: 'Submitted', claimStatus: previousClaimStatus },
      new: { investigationStatus: 'Reviewed', claimStatus: newClaimStatus, conclusion, reviewNotes },
    },
  });

  return { investigation, claimStatus: newClaimStatus, conclusion };
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
  assignInvestigator,
  getInvestigationByToken,
  submitInvestigationReport,
  reviewInvestigationReport,
  getMyInvestigations,
  getAllInvestigations,
  getInvestigationById,
};
