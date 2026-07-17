const crypto = require('crypto');
const bcrypt = require('bcrypt');
const ApiKey = require('../models/apiKey.model');

const generateApiKey = async (data) => {
  const { company, keyName, permissions, expiresAt, createdBy } = data;

  const rawKey = crypto.randomBytes(32).toString('hex');
  const keyPrefix = rawKey.substring(0, 8);
  const keyHash = await bcrypt.hash(rawKey, 10);

  const apiKey = new ApiKey({
    company,
    keyName,
    keyPrefix,
    keyHash,
    permissions: permissions || [],
    expiresAt: expiresAt ? new Date(expiresAt) : null,
    createdBy,
  });

  await apiKey.save();

  // Return the raw key ONCE — it cannot be retrieved again
  return { apiKey, rawKey: `${keyPrefix}.${rawKey.substring(8)}` };
};

const getAllApiKeys = async ({ company, status, page = 1, limit = 20 } = {}) => {
  const filter = {};
  if (company) filter.company = company;
  if (status) filter.status = status;
  const skip = (page - 1) * limit;
  const [keys, total] = await Promise.all([
    ApiKey.find(filter)
      .populate('company', 'companyName email')
      .select('-keyHash')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    ApiKey.countDocuments(filter),
  ]);
  return { keys, total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) };
};

const getApiKeysByCompany = async (companyId) => {
  return ApiKey.find({ company: companyId }).select('-keyHash').sort({ createdAt: -1 });
};

const getApiKeyById = async (id) => {
  return ApiKey.findById(id).select('-keyHash').populate('company', 'companyName email');
};

const revokeApiKey = async (id, revokedBy) => {
  return ApiKey.findByIdAndUpdate(
    id,
    { status: 'revoked', revokedAt: new Date(), revokedBy },
    { new: true }
  ).select('-keyHash');
};

const deleteApiKey = async (id) => {
  return ApiKey.softDeleteById(id);
};

const verifyApiKey = async (rawKey) => {
  const prefix = rawKey.substring(0, 8);
  const now = new Date();
  const keys = await ApiKey.find({
    keyPrefix: prefix,
    status: 'active',
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  }).populate('company', 'companyName email status');

  for (const key of keys) {
    const normalised = rawKey.replace('.', '').substring(0, 64);
    const match = await bcrypt.compare(normalised, key.keyHash);
    if (match) {
      key.lastUsedAt = now;
      key.usageCount += 1;
      await key.save();
      return key;
    }
  }
  return null;
};

module.exports = {
  generateApiKey,
  getAllApiKeys,
  getApiKeysByCompany,
  getApiKeyById,
  revokeApiKey,
  deleteApiKey,
  verifyApiKey,
};
