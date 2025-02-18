const customerService = require("../service/customerService");
const tokenService = require("../service/token.service");

const createCustomer = async (req, res) => {
  try {
    const customerCreated = await customerService.createCustomer(req.body);

    if (customerCreated && customerCreated.email) {
      await customerService.sendWelcomeEmail(customerCreated);
    }

    res.status(201).json(customerCreated); // Resource created
  } catch (error) {
    console.error('Error creating customer:', error);
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
    res.status(200).json({ user, tokens });
  } catch (error) {
    res.status(401).json({ message: error.message });
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

const resetPassword = async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    const response = await customerService.resetPassword(email, newPassword);
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


module.exports = {
  createCustomer,
  login,
  getAllCustomers,
  getCustomerClaims,
  resetPassword,
  updateCustomer,
  getCustomerStats,
  getGarage
};
