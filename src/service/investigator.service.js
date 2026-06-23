const bcrypt = require('bcryptjs');
const Investigator = require('../models/investigator.model');
const Investigation = require('../models/investigation.model');
const Claim = require('../models/claim.model');
const ApiError = require('../utils/ApiError');
const emailService = require('./email.service');
const notificationService = require('./notification.service');
const { writeAuditLog } = require('../utils/auditHelper');

const createInvestigator = async (data, req) => {
  const existing = await Investigator.findOne({ email: data.email });
  if (existing) throw new ApiError(409, 'Investigator already exists with this email');

  const plainPassword = data.password;
  const start = Date.now();
  data.password = await bcrypt.hash(plainPassword, 10);
  const investigator = await Investigator.create(data);

  await emailService.sendEmailNotification(
    investigator.email,
    'Welcome to AVE Insurance — Investigator Account',
    `Dear ${investigator.name},\n\nYour investigator account has been created.\n\nLogin Details:\n  Email:    ${investigator.email}\n  Password: ${plainPassword}\n  Role:     ${investigator.accountType}\n\nPlease log in and change your password at your earliest convenience.\n\nRegards,\nThe AVE Insurance Team`
  );

  const safeData = { ...data };
  delete safeData.password;
  await writeAuditLog(req, {
    action: 'CREATE',
    module: 'Investigator',
    actionDescription: `Created investigator account for ${investigator.email}`,
    resourceType: 'Investigator',
    resourceId: investigator._id,
    statusCode: 201,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: null, new: safeData },
  });

  return investigator;
};

const loginWithEmailAndPassword = async (email, password) => {
  const user = await Investigator.findOne({ email });
  if (!user) throw new ApiError(401, 'Invalid email or password');

  const isMatch = await user.isPasswordMatch(password);
  if (!isMatch) throw new ApiError(401, 'Invalid email or password');

  return user;
};

const getAllInvestigators = async (filter = {}, page = 1, limit = 10) => {
  const query = {};
  if (filter.city) query['location.city'] = new RegExp(filter.city, 'i');
  if (filter.specialization) query.specializations = filter.specialization;
  if (filter.name) query.name = new RegExp(filter.name, 'i');

  const skip = (page - 1) * limit;
  const [investigators, total] = await Promise.all([
    Investigator.find(query).select('-password').skip(skip).limit(Number(limit)).sort({ createdAt: -1 }),
    Investigator.countDocuments(query),
  ]);

  return { investigators, total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) };
};

const getInvestigatorById = async (id) => {
  const investigator = await Investigator.findById(id).select('-password');
  if (!investigator) throw new ApiError(404, 'Investigator not found');
  return investigator;
};

const updateInvestigator = async (id, data, req) => {
  const investigator = await Investigator.findById(id);
  if (!investigator) throw new ApiError(404, 'Investigator not found');

  // Never allow password changes via the update endpoint
  delete data.password;

  const start = Date.now();
  const oldData = investigator.toObject();
  delete oldData.password;

  const updated = await Investigator.findByIdAndUpdate(id, data, { new: true }).select('-password');

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
  delete snapshot.password;
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

const resetPassword = async (email, newPassword) => {
  const user = await Investigator.findOne({ email });
  if (!user) throw new ApiError(404, 'Investigator not found');
  user.password = await bcrypt.hash(newPassword, 10);
  await user.save();
  return { message: 'Password reset successfully' };
};

const getInvestigatorStats = async () => {
  const total = await Investigator.countDocuments();
  const active = await Investigator.countDocuments({ pendingInvestigations: { $gt: 0 } });
  const activeInvestigations = await Investigation.countDocuments({ status: { $in: ['Pending', 'In Progress'] } });
  const submitted = await Investigation.countDocuments({ status: 'Submitted' });
  return { total, active, idle: total - active, activeInvestigations, awaitingReview: submitted };
};

// Insurance company assigns an investigator to a claim after suspecting fraud
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

  const investigation = await Investigation.create({
    claimId,
    investigatorId,
    assignedBy,
    assignedByType,
    reason,
    status: 'Pending',
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

  // Notify investigator
  await notificationService.createAndEmit({
    recipientId: investigatorId,
    recipientType: 'investigator',
    type: 'investigation_assigned',
    title: 'New Investigation Assigned',
    content: `You have been assigned to investigate claim #${claimId}. Reason: ${reason}`,
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

  // Email investigator
  await emailService.sendEmailNotification(
    investigator.email,
    'Investigation Assignment — AVE Insurance',
    `Dear ${investigator.name},\n\nYou have been assigned to investigate the following claim.\n\nClaim ID: ${claimId}\nReason: ${reason}\n\nPlease log in to the platform to begin your investigation.\n\nRegards,\nThe AVE Insurance Team`
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

// Investigator submits their investigation report
const submitInvestigationReport = async (investigationId, report, req) => {
  const investigation = await Investigation.findById(investigationId).populate('claimId');
  if (!investigation) throw new ApiError(404, 'Investigation not found');

  if (!['Pending', 'In Progress'].includes(investigation.status)) {
    throw new ApiError(400, 'Report has already been submitted for this investigation');
  }

  const start = Date.now();

  investigation.report = {
    findings: report.findings,
    conclusion: report.conclusion,
    evidence: report.evidence || [],
    submittedAt: new Date(),
  };
  investigation.status = 'Submitted';
  await investigation.save();

  const claim = await Claim.findById(investigation.claimId);
  if (claim) {
    claim.status = 'Investigated';
    await claim.save();
  }

  // Decrement investigator pending count
  await Investigator.findByIdAndUpdate(investigation.investigatorId, {
    $inc: { pendingInvestigations: -1 },
  });

  // Notify admin/insurance company (use assignedBy as recipient)
  await notificationService.createAndEmit({
    recipientId: investigation.assignedBy,
    recipientType: investigation.assignedByType === 'admin' ? 'admin' : 'admin',
    type: 'investigation_submitted',
    title: 'Investigation Report Submitted',
    content: `The investigation report for claim #${investigation.claimId} has been submitted. Conclusion: ${report.conclusion}`,
    claimId: investigation.claimId,
  });

  // Notify customer
  if (claim && claim.customerId) {
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
    actionDescription: `Investigator submitted report for investigation ${investigationId}`,
    resourceType: 'Investigation',
    resourceId: investigationId,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: 'In Progress' }, new: { status: 'Submitted', conclusion: report.conclusion } },
  });

  return investigation;
};

// Update investigation status to In Progress (investigator acknowledges assignment)
const startInvestigation = async (investigationId, req) => {
  const investigation = await Investigation.findById(investigationId);
  if (!investigation) throw new ApiError(404, 'Investigation not found');
  if (investigation.status !== 'Pending') throw new ApiError(400, 'Investigation is not in Pending status');

  const start = Date.now();
  investigation.status = 'In Progress';
  await investigation.save();

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Investigation',
    actionDescription: `Investigation ${investigationId} marked as In Progress`,
    resourceType: 'Investigation',
    resourceId: investigationId,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: 'Pending' }, new: { status: 'In Progress' } },
  });

  return investigation;
};

// Admin/insurance company reviews submitted report
const reviewInvestigationReport = async (investigationId, reviewNotes, reviewedBy, req) => {
  const investigation = await Investigation.findById(investigationId);
  if (!investigation) throw new ApiError(404, 'Investigation not found');
  if (investigation.status !== 'Submitted') throw new ApiError(400, 'Only submitted investigations can be reviewed');

  const start = Date.now();
  investigation.reviewNotes = reviewNotes;
  investigation.reviewedAt = new Date();
  investigation.reviewedBy = reviewedBy;
  investigation.status = 'Reviewed';
  await investigation.save();

  // Notify customer of review completion
  const claim = await Claim.findById(investigation.claimId);
  if (claim && claim.customerId) {
    await notificationService.createAndEmit({
      recipientId: claim.customerId,
      recipientType: 'customer',
      type: 'investigation_completed',
      title: 'Investigation Review Complete',
      content: 'Your insurance provider has reviewed the investigation findings. A decision on your claim will follow shortly.',
      claimId: investigation.claimId,
    });
  }

  await writeAuditLog(req, {
    action: 'UPDATE',
    module: 'Investigation',
    actionDescription: `Investigation ${investigationId} reviewed by ${reviewedBy}`,
    resourceType: 'Investigation',
    resourceId: investigationId,
    statusCode: 200,
    success: true,
    responseTimeMs: Date.now() - start,
    changes: { old: { status: 'Submitted' }, new: { status: 'Reviewed', reviewNotes } },
  });

  return investigation;
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
  loginWithEmailAndPassword,
  getAllInvestigators,
  getInvestigatorById,
  updateInvestigator,
  deleteInvestigator,
  resetPassword,
  getInvestigatorStats,
  assignInvestigator,
  submitInvestigationReport,
  startInvestigation,
  reviewInvestigationReport,
  getMyInvestigations,
  getAllInvestigations,
  getInvestigationById,
};
