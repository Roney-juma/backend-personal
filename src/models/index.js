module.exports.User = require('./users.model');
module.exports.Assessor = require('./assessor.model');
module.exports.AuditLog = require('./audit.model');
module.exports.Token = require('./token.model');
module.exports.Claim = require('./claim.model');
module.exports.Garage = require('./garage.model');
module.exports.Supplier = require('./supplier.model');

// Provider / client management
module.exports.InsuranceCompany = require('./insuranceCompany.model');
module.exports.SubscriptionPlan = require('./subscriptionPlan.model');
module.exports.CompanySubscription = require('./companySubscription.model');
module.exports.Invoice = require('./invoice.model');
module.exports.VendorInvoice = require('./vendorInvoice.model');
module.exports.ApiKey = require('./apiKey.model');
module.exports.SupportTicket = require('./supportTicket.model');
module.exports.CompanyActivity = require('./companyActivity.model');
module.exports.ProviderAuditLog = require('./providerAuditLog.model');

// Legal & Litigation. The Claim stays the master accident record; these hang off
// it — see AVICS-Legal-Module-Work-Plan.html for the design.
module.exports.Counter = require('./counter.model');
module.exports.AuditSeal = require('./auditSeal.model');
module.exports.LegalConfig = require('./legalConfig.model');
module.exports.ThirdPartyClaim = require('./thirdPartyClaim.model');
module.exports.LegalCase = require('./legalCase.model');
module.exports.LegalEvent = require('./legalEvent.model');
module.exports.LegalDocument = require('./legalDocument.model');
module.exports.LegalDocumentAccess = require('./legalDocument.model').LegalDocumentAccess;
module.exports.LegalLedgerEntry = require('./legalLedgerEntry.model');
module.exports.Advocate = require('./advocate.model');
module.exports.ApprovalRequest = require('./approvalRequest.model');
module.exports.Settlement = require('./settlement.model');
module.exports.Recovery = require('./recovery.model');
module.exports.LegalReferral = require('./legalReferral.model');

// Internal workspace (platform team): meetings/calendar + task tracking.
module.exports.Meeting = require('./meeting.model');
module.exports.Task = require('./task.model');
