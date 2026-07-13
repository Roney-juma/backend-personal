const customerService = require("../service/customerService");
const tokenService = require("../service/token.service");
const logger = require('../middlewheres/logger');

const createCustomer = async (req, res) => {
  try {
    const customerCreated = await customerService.createCustomer(req.body);

    if (customerCreated && customerCreated.email) {
      await customerService.sendWelcomeEmail(customerCreated);
    }

    res.status(201).json(customerCreated); // Resource created
  } catch (error) {
    logger.error('Error creating customer: %s', error.message);
    if (error.message === 'Customer already exists') {
      res.status(409).json({ error: 'Customer already exists' });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const { user, tokens } = await customerService.loginUser(email, password);
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

const getAllCustomers = async (req, res) => {
  try {
    const customers = await customerService.getCustomers();
    res.status(200).json(customers);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getCustomerClaims = async (req, res) => {
  try {
    const customerId = req.params.customerId;
    const claims = await customerService.getCustomerClaims(customerId);
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
    res.status(400).json({ error: err.message });
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
    const updatedCustomer = await customerService.updateCustomer(customerId, customer);
    res.status(200).json(updatedCustomer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
// customerStats
const getCustomerStats = async (req, res) => {
  try {
    const stats = await customerService.getCustomerStats();
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
  login,
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
