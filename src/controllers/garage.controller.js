const garageService = require('../service/garage.service');
const tokenService = require('../service/token.service');
const emailService = require('../service/email.service');
const logger = require('../middlewheres/logger');
const { getRequesterCompany, belongsToCompany } = require('../utils/requesterCompany');

const createGarage = async (req, res) => {
  try {
    const rawPassword = req.body.password;
    // The garage belongs to the company of the user creating it (ignore any
    // client-supplied company to prevent spoofing). Platform staff → no company.
    const company = await getRequesterCompany(req);
    const newGarage = await garageService.createGarage({ ...req.body, company: company || undefined });

    await emailService.sendEmailNotification(
      newGarage.email,
      'Welcome To AVE Insurance',
      `Dear ${newGarage.name},\n\nYour account has been created on the AVE Insurance platform.\n\nLogin Details:\n  Email:    ${newGarage.email}\n  Password: ${rawPassword}\n  Role:     ${newGarage.accountType}\n\nPlease log in and change your password at your earliest convenience.\n\nRegards,\nThe AVE Insurance Team`
    );

    res.status(201).json(newGarage);
  } catch (error) {
    logger.error('Error creating garage: %s', error.message);
    res.status(409).json({ message: error.message });
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await garageService.loginUserWithEmailAndPassword(email, password);

    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    if (user.mfaEnabled) {
      const mfaToken = tokenService.generateMfaChallengeToken(user._id, 'Garage');
      return res.status(200).json({ mfaRequired: true, mfaToken });
    }

    const tokens = tokenService.GenerateToken(user);
    res.status(200).json({ user, tokens });
  } catch (error) {
    if (error.code === 'ACCOUNT_LOCKED') {
      return res.status(429).json({ message: error.message });
    }
    logger.error('Error during garage login: %s', error.message);
    res.status(500).json({ message: error.message });
  }
};

const getAllGarages = async (req, res) => {
  try {
    const { page = 1, limit = 10, city, estate, state } = req.query;
    const filter = {};

    if (city) filter.city = city;
    if (estate) filter.estate = estate;
    if (state) filter.state = state;

    // Company users only see their own company's garages; platform staff see all.
    const company = await getRequesterCompany(req);
    if (company) filter.company = company;

    const garages = await garageService.getAllGarages(filter, page, limit);
    res.status(200).json(garages);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getGarage = async (req, res) => {
  try {
    const garage = await garageService.getGarage(req.params.garageId);
    if (!garage) return res.status(404).json({ message: 'Garage not found' });
    // A company user may only view their own company's garages.
    const company = await getRequesterCompany(req);
    if (!belongsToCompany(garage.company, company)) {
      return res.status(404).json({ message: 'Garage not found' });
    }
    res.status(200).json(garage);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateGarage = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const updatedGarage = await garageService.updateGarage(req.params.garageId, req.body, company);
    if (!updatedGarage) return res.status(404).json({ message: 'Garage not found' });
    res.status(200).json(updatedGarage);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const deleteGarage = async (req, res) => {
  try {
    const company = await getRequesterCompany(req);
    const deletedGarage = await garageService.deleteGarage(req.params.garageId, company);
    if (!deletedGarage) return res.status(404).json({ message: 'Garage not found' });
    res.status(200).json({ message: 'Garage deleted successfully' });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const getAssessedClaims = async (req, res) => {
  try {
    const claims = await garageService.getAssessedClaims(req.params.garageId);
    res.status(200).json(claims);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const placeBid = async (req, res) => {
  const { garageId, description, timeline, parts } = req.body;

  try {
    const bid = await garageService.placeBid(req.params.id, garageId, description, timeline, parts);
    res.status(201).json(bid);
  } catch (error) {
    logger.error('Error placing garage bid: %s', error.message);
    res.status(500).json({ message: error.message });
  }
};

const completeRepair = async (req, res) => {
  try {
    const { workDone, vehicleCondition, partsSalvaged, partsReplaced, receipts, photos, totalRepairCost, garageId } = req.body;
    const report = { workDone, vehicleCondition, partsSalvaged, partsReplaced, receipts, photos, totalRepairCost };
    const claim = await garageService.callForReAssessment(req.params.id, garageId, report);
    res.status(200).json(claim);
  } catch (error) {
    logger.error('Error completing repair: %s', error.message);
    res.status(500).json({ message: error.message });
  }
};

const getGarageBids = async (req, res) => {
  try {
    const garageBids = await garageService.getGarageBids(req.params.garageId);
    res.status(200).json(garageBids);
  } catch (error) {
    logger.error('Error fetching garage bids: %s', error.message);
    res.status(500).json({ message: error.message });
  }
};

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const response = await garageService.forgotPassword(email);
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
    const response = await garageService.resetPassword(email, token, newPassword);
    res.status(200).json(response);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const getGarageStats = async (req, res) => {
  try {
    const stats = await garageService.getGarageStats();
    res.status(200).json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getTopGarages = async (req, res) => {
  try {
    const topGarages = await garageService.getTopGarages();
    res.status(200).json(topGarages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const updateFcmToken = async (req, res) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken) return res.status(400).json({ message: 'fcmToken is required' });
    const { updateFcmToken: update } = require('../service/firebase.service');
    await update(req.params.id, 'garage', fcmToken);
    res.status(200).json({ message: 'FCM token updated' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  createGarage,
  login,
  getAllGarages,
  getGarage,
  updateGarage,
  deleteGarage,
  getAssessedClaims,
  placeBid,
  completeRepair,
  getGarageBids,
  forgotPassword,
  resetPassword,
  getGarageStats,
  getTopGarages,
  updateFcmToken,
};
