const apiKeyService = require('../service/apiKey.service');

const generateApiKey = async (req, res) => {
  try {
    const result = await apiKeyService.generateApiKey({ ...req.body, createdBy: req.user?.id });
    res.status(201).json({
      message: 'API key generated. Save the raw key — it will not be shown again.',
      apiKey: result.apiKey,
      rawKey: result.rawKey,
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const getAllApiKeys = async (req, res) => {
  try {
    const result = await apiKeyService.getAllApiKeys(req.query);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getApiKeysByCompany = async (req, res) => {
  try {
    const keys = await apiKeyService.getApiKeysByCompany(req.params.companyId);
    res.status(200).json(keys);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getApiKeyById = async (req, res) => {
  try {
    const key = await apiKeyService.getApiKeyById(req.params.id);
    if (!key) return res.status(404).json({ message: 'API key not found' });
    res.status(200).json(key);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const revokeApiKey = async (req, res) => {
  try {
    const key = await apiKeyService.revokeApiKey(req.params.id, req.user?.id);
    if (!key) return res.status(404).json({ message: 'API key not found' });
    res.status(200).json({ message: 'API key revoked', key });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteApiKey = async (req, res) => {
  try {
    await apiKeyService.deleteApiKey(req.params.id);
    res.status(200).json({ message: 'API key deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { generateApiKey, getAllApiKeys, getApiKeysByCompany, getApiKeyById, revokeApiKey, deleteApiKey };
