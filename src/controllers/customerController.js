const customerService = require("../service/customerService");
const activationService = require("../service/activation.service");
const tokenService = require("../service/token.service");
const logger = require('../middlewheres/logger');
const { getRequesterCompany } = require('../utils/requesterCompany');
const { writeAuditLog } = require('../utils/auditHelper');

// Requester-company scoping applies only to insurer-portal audiences (company
// admins and AVE platform staff — staff resolve to null → global scope). Mobile
// customers share some of these routes but are identified by their own ids, so
// their queries are never requester-scoped.
const portalCompany = async (req) => {
  const type = req.user?.accountType;
  if (type !== 'CompanyUser' && type !== 'ProviderUser') return null;
  return getRequesterCompany(req);
};

// Activation-flow errors carry statusCode + a machine-readable code (contract §2).
const respondActivationError = (res, error) => {
  const body = { message: error.message };
  if (error.code) body.code = error.code;
  res.status(error.statusCode || 400).json(body);
};

const createCustomer = async (req, res) => {
  try {
    // Registration is public (no req.user), but when the insurer portal creates a
    // customer the requester's company overrides any client-supplied tenant.
    const isPortalUser = req.user?.accountType === 'CompanyUser' || req.user?.accountType === 'ProviderUser';

    // Contract §5: open self-registration is deprecated behind a flag (default
    // enabled). When flipped off, the public endpoint points users at the
    // book-activation flow. Portal-created customers are unaffected.
    if (process.env.OPEN_REGISTRATION_ENABLED === 'false' && !isPortalUser) {
      return res.status(410).json({
        code: 'REGISTRATION_CLOSED',
        message: 'Open registration is closed. Please verify your account with your insurer in the app to activate it.',
      });
    }
    const requesterCompany = isPortalUser ? await getRequesterCompany(req) : null;
    const customerCreated = await customerService.createCustomer(req.body, requesterCompany);

    if (customerCreated && customerCreated.email) {
      await customerService.sendWelcomeEmail(customerCreated);
    }

    // Audit only portal-created customers — public self-registration is not an
    // admin action and would pollute the tenant's audit report.
    if (isPortalUser) {
      await writeAuditLog(req, {
        action: 'CREATE',
        module: 'Customer',
        actionDescription: `Created customer ${customerCreated.firstName} ${customerCreated.lastName} (${customerCreated.email})`,
        resourceType: 'Customer',
        resourceId: customerCreated._id,
        statusCode: 201,
        success: true,
        changes: { old: null, new: { firstName: customerCreated.firstName, lastName: customerCreated.lastName, email: customerCreated.email } },
      });
    }

    res.status(201).json(customerCreated); // Resource created
  } catch (error) {
    logger.error('Error creating customer: %s', error.message);
    if (error.message === 'Customer already exists') {
      res.status(409).json({ error: 'Customer already exists' });
    } else {
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  }
};

// Portal-only bulk import / single add. Body: { customers: [...], dryRun?: bool }.
// Customers are scoped to the requester's company; dryRun validates without saving.
const importCustomers = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const report = await customerService.importCustomers(req.body, company);

    if (!report.dryRun && report.created > 0) {
      await writeAuditLog(req, {
        action: 'CREATE',
        module: 'Customer',
        actionDescription: `Imported ${report.created} customer(s) (${report.invalid} invalid, ${report.duplicates} duplicate)`,
        resourceType: 'Customer',
        statusCode: 201,
        success: true,
        changes: { old: null, new: { imported: report.created } },
      });
    }

    res.status(report.dryRun ? 200 : 201).json(report);
  } catch (error) {
    logger.error('Error importing customers: %s', error.message);
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const login = async (req, res) => {
  try {
    const { email, password, companyId } = req.body;
    const result = await customerService.loginUser(email, password, companyId);
    // Multi-insurer: password matched records at more than one insurer — the
    // app shows a picker and repeats login with companyId (contract §3).
    if (result.selectCompany) {
      return res.status(200).json(result);
    }
    const { user, tokens } = result;
    if (user.mfaEnabled) {
      const mfaToken = tokenService.generateMfaChallengeToken(user._id, 'Customer');
      return res.status(200).json({ mfaRequired: true, mfaToken });
    }
    res.status(200).json({ user, tokens });
  } catch (error) {
    const status = error.code === 'ACCOUNT_LOCKED' ? 429 : 401;
    res.status(status).json({ message: error.message });
  }
};

// --- Mobile account activation (contract §2) ---

const verifyAccount = async (req, res) => {
  try {
    const { companyId, email, phone } = req.body;
    const result = await activationService.verifyAccount({ companyId, email, phone, ipAddress: req.ip });
    res.status(200).json(result);
  } catch (error) {
    respondActivationError(res, error);
  }
};

const confirmVerifyAccount = async (req, res) => {
  try {
    const { companyId, email, phone, code } = req.body;
    const result = await activationService.confirmVerification({ companyId, email, phone, code });
    res.status(200).json(result);
  } catch (error) {
    respondActivationError(res, error);
  }
};

const activateAccount = async (req, res) => {
  try {
    const { activationToken, password } = req.body;
    if (!activationToken) {
      return res.status(401).json({ code: 'INVALID_ACTIVATION_TOKEN', message: 'Activation token is required' });
    }
    const result = await activationService.activateAccount({ activationToken, password });
    res.status(201).json(result);
  } catch (error) {
    respondActivationError(res, error);
  }
};

const getAllCustomers = async (req, res) => {
  try {
    // Company users only see their own company's customers; platform staff see all.
    const customers = await customerService.getCustomers(await portalCompany(req));
    res.status(200).json(customers);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getCustomerClaims = async (req, res) => {
  try {
    const customerId = req.params.customerId;
    // Mobile customers may only read their own claims; portal users only their
    // company's customers (staff → global).
    if (req.user?.accountType === 'Customer' && String(req.user.id) !== String(customerId)) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    const company = await portalCompany(req);
    const claims = await customerService.getCustomerClaims(customerId, company);
    res.status(200).json(claims);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const response = await customerService.forgotPassword(email);
    res.status(200).json(response);
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
};

const resetPassword = async (req, res) => {
  try {
    const { email, token, newPassword } = req.body;
    if (!email || !token || !newPassword) {
      return res.status(400).json({ error: 'Email, token and newPassword are required' });
    }
    const response = await customerService.resetPassword(email, token, newPassword);
    res.status(200).json(response);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// updateCustomer
const updateCustomer = async (req, res) => {
  try {
    const customerId = req.params.customerId;
    const customer = req.body;
    // Mobile customers may only update their own record (their token is never
    // requester-scoped, so pin the id instead).
    if (req.user?.accountType === 'Customer' && String(req.user.id) !== String(customerId)) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    const company = await portalCompany(req);
    const updatedCustomer = await customerService.updateCustomer(customerId, customer, company);
    // Cross-tenant ids 404 like missing ones.
    if (!updatedCustomer) return res.status(404).json({ error: 'Customer not found' });
    // Audit only portal-side edits — a mobile customer updating their own
    // profile is not an admin action.
    if (req.user?.accountType === 'CompanyUser' || req.user?.accountType === 'ProviderUser') {
      await writeAuditLog(req, {
        action: 'UPDATE',
        module: 'Customer',
        actionDescription: `Updated customer ${updatedCustomer.firstName} ${updatedCustomer.lastName} (${updatedCustomer.email})`,
        resourceType: 'Customer',
        resourceId: updatedCustomer._id,
        statusCode: 200,
        success: true,
      });
    }
    res.status(200).json(updatedCustomer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
// customerStats
const getCustomerStats = async (req, res) => {
  try {
    const stats = await customerService.getCustomerStats(await portalCompany(req));
    res.status(200).json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
const getGarage = async (req, res) => {
  try {
    const garage = await customerService.findGarages(req.params.claimId);
    res.status(200).json(garage);
    } catch (error) {
      res.status(500).json({ error: error.message });
      }
  };


const updateFcmToken = async (req, res) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken) return res.status(400).json({ message: 'fcmToken is required' });
    const { updateFcmToken: update } = require('../service/firebase.service');
    await update(req.params.id, 'customer', fcmToken);
    res.status(200).json({ message: 'FCM token updated' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const requestAccountDeletion = async (req, res) => {
  try {
    const { email, phone } = req.body;
    if (!email || !phone) return res.status(400).json({ message: 'email and phone are required' });
    const response = await customerService.requestAccountDeletion({ email, phone });
    res.status(200).json(response);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

module.exports = {
  createCustomer,
  importCustomers,
  login,
  verifyAccount,
  confirmVerifyAccount,
  activateAccount,
  getAllCustomers,
  getCustomerClaims,
  forgotPassword,
  resetPassword,
  updateCustomer,
  getCustomerStats,
  getGarage,
  updateFcmToken,
  requestAccountDeletion,
};
