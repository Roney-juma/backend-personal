const insuranceCompanyService = require('../service/insuranceCompany.service');
const tokenService = require('../service/token.service');

const createCompany = async (req, res) => {
  try {
    const company = await insuranceCompanyService.createCompany(req.body);
    res.status(201).json(company);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const getAllCompanies = async (req, res) => {
  try {
    const result = await insuranceCompanyService.getAllCompanies(req.query);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
const getCompanyUsers = async (req, res) => {
  try {
    const { page = 1, limit = 10, search = '' } = req.query;
    const result = await insuranceCompanyService.getCompanyUsers(req.params.id, { page, limit, search });
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getCompanyById = async (req, res) => {
  try {
    const company = await insuranceCompanyService.getCompanyById(req.params.id);
    if (!company) return res.status(404).json({ message: 'Company not found' });
    res.status(200).json(company);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateCompany = async (req, res) => {
  try {
    const company = await insuranceCompanyService.updateCompany(req.params.id, req.body);
    if (!company) return res.status(404).json({ message: 'Company not found' });
    res.status(200).json(company);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateCompanyStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ message: 'Status is required' });
    const company = await insuranceCompanyService.updateCompanyStatus(req.params.id, status);
    if (!company) return res.status(404).json({ message: 'Company not found' });
    res.status(200).json(company);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteCompany = async (req, res) => {
  try {
    const company = await insuranceCompanyService.deleteCompany(req.params.id);
    if (!company) return res.status(404).json({ message: 'Company not found' });
    res.status(200).json({ message: 'Company deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const loginCompany = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required' });
    const company = await insuranceCompanyService.loginCompany(email, password);
    if (!company) return res.status(401).json({ message: 'Invalid email or password' });
    const token = tokenService.generateCompanyToken(company);
    res.status(200).json({ company: { ...company.toObject(), password: undefined }, token });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const resetCompanyPassword = async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    const result = await insuranceCompanyService.resetCompanyPassword(email, newPassword);
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const getCompanyStats = async (req, res) => {
  try {
    const stats = await insuranceCompanyService.getCompanyStats(req.params.id);
    res.status(200).json(stats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  createCompany,
  getAllCompanies,
  getCompanyById,
  updateCompany,
  updateCompanyStatus,
  deleteCompany,
  loginCompany,
  resetCompanyPassword,
  getCompanyStats,
  getCompanyUsers
};
