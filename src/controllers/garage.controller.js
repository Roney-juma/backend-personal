const garageService = require('../service/garage.service');
const tokenService = require('../service/token.service');

const createGarage = async (req, res) => {
  try {
    const newGarage = await garageService.createGarage(req.body);
    res.status(201).json(newGarage);
  } catch (error) {
    console.error('Error creating garage:', error.message);
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

    const tokens = tokenService.GenerateToken(user);
    res.status(200).json({ user, tokens });
  } catch (error) {
    console.error('Error during login:', error.message);
    res.status(500).json({ message: error.message });
  }
};

const getAllGarages = async (req, res) => {
  try {
    const { page = 1, limit = 10, city, estate, state } = req.query;
    const filter = {};

    if (city) {
      filter.city = city;
    }

    if (estate) {
      filter.estate = estate;
    }

    if (state) {
      filter.state = state;
    }

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
    res.status(200).json(garage);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateGarage = async (req, res) => {
  try {
    const updatedGarage = await garageService.updateGarage(req.params.garageId, req.body);
    if (!updatedGarage) return res.status(404).json({ message: 'Garage not found' });
    res.status(200).json(updatedGarage);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const deleteGarage = async (req, res) => {
  try {
    const deletedGarage = await garageService.deleteGarage(req.params.garageId);
    if (!deletedGarage) return res.status(404).json({ message: 'Garage not found' });
    res.status(200).json({ message: 'Garage deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
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
    console.error('Error placing bid:', error.message);
    res.status(500).json({ message: error.message });
  }
};


const completeRepair = async (req, res) => {
  try {
    const claim = await garageService.callForReAssessment(req.params.id);
    res.status(200).json(claim);
  } catch (error) {
    console.error('Error completing repair:', error.message);
    res.status(500).json({ message: error.message });
  }
};

const getGarageBids = async (req, res) => {
  try {
    const garageBids = await garageService.getGarageBids(req.params.garageId);
    res.status(200).json(garageBids);
  } catch (error) {
    console.error('Error fetching garage bids:', error.message);
    res.status(500).json({ message: error.message });
  }
};
const resetPassword = async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    const response = await garageService.resetPassword(email, newPassword);
    res.status(200).json(response);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
// Garage stats
const getGarageStats = async (req, res) => {
  try {
    const stats = await garageService.getGarageStats();
    res.status(200).json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
// Top Garages 
const getTopGarages = async (req, res) => {
  try {
    const topGarages = await garageService.getTopGarages();
    res.status(200).json(topGarages);
  } catch (error) {
    res.status(500).json({ error: error.message });
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
  resetPassword,
  getGarageStats,
  getTopGarages
};
