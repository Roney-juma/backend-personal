const apiKeyService = require('../service/apiKey.service');

/**
 * Middleware — authenticates a request using an API key.
 *
 * Accepted header formats:
 *   x-api-key: <key>
 *   Authorization: ApiKey <key>
 *
 * On success attaches:
 *   req.apiKey   — the ApiKey document (without keyHash)
 *   req.company  — the populated InsuranceCompany document
 *
 * Optional: pass an array of required permission strings.
 *   e.g. verifyApiKey(['claims:read', 'claims:write'])
 */
const verifyApiKey = (requiredPermissions = []) => async (req, res, next) => {
  try {
    const raw =
      req.headers['x-api-key'] ||
      (req.headers['authorization'] || '').replace(/^apikey\s+/i, '').replace(/^bearer\s+/i, '');

    if (!raw) {
      return res.status(401).json({
        message: 'API key required. Supply it via x-api-key header or Authorization: ApiKey <key>',
      });
    }

    const apiKey = await apiKeyService.verifyApiKey(raw);

    if (!apiKey) {
      return res.status(401).json({ message: 'Invalid or expired API key' });
    }

    // Hard-deny anything but a live, active company. A soft-deleted company
    // populates as null here — without this check its leftover keys would
    // authenticate with req.company = null, i.e. GLOBAL scope.
    if (!apiKey.company || apiKey.company.status !== 'active') {
      return res.status(403).json({ message: 'Your company account is not active' });
    }

    if (requiredPermissions.length > 0) {
      const granted = apiKey.permissions || [];
      const missing = requiredPermissions.filter((p) => !granted.includes(p));
      if (missing.length > 0) {
        return res.status(403).json({
          message: `API key missing required permissions: ${missing.join(', ')}`,
        });
      }
    }

    req.apiKey = apiKey;
    req.company = apiKey.company;
    next();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = verifyApiKey;
