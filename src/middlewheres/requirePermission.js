const logger = require('./logger');
const cache = require('../cache');
const User = require('../models/users.model');

// Safe rollout: while OFF, a would-be denial is logged (so you can watch the
// logs and re-seed roles) but the request proceeds. Flip RBAC_ENFORCED=true to
// actually block. Super-admin/admin roles are always allowed either way.
const isEnforced = () => process.env.RBAC_ENFORCED === 'true';

// A role whose name normalises to admin/superadmin is unrestricted — mirrors the
// frontend's useAuth.hasPermission so both sides agree.
const isAdminRole = (roleName) => {
  const n = String(roleName || '').toLowerCase().replace(/[\s_-]/g, '');
  return n === 'admin' || n === 'superadmin';
};

// Resolve { roleName, permissions } for the authenticated request. Prefer values
// embedded in the JWT (fast, set at login); fall back to a short-cached DB lookup
// for tokens issued before permissions were embedded.
const resolvePermissions = async (req) => {
  const u = req.user || {};
  if (Array.isArray(u.permissions)) {
    return { roleName: u.roleName || (u.role && u.role.name) || null, permissions: u.permissions };
  }
  const userId = u.id || u._id;
  if (!userId) return { roleName: null, permissions: [] };
  return cache.wrap(
    `rbac:perms:${userId}`,
    async () => {
      const user = await User.findById(userId).populate('role', 'name permissions').lean();
      return { roleName: user?.role?.name || null, permissions: user?.role?.permissions || [] };
    },
    120,
  );
};

const holds = (permissions, roleName, required) => {
  if (isAdminRole(roleName)) return true;
  const owned = new Set((permissions || []).map((p) => String(p).toUpperCase()));
  return owned.has(String(required).toUpperCase());
};

/**
 * requirePermission('APPROVE_CLAIM') — Express middleware. Mount AFTER verifyToken.
 * 403s when the caller's role lacks the permission (once RBAC_ENFORCED=true).
 */
const requirePermission = (permission) => async (req, res, next) => {
  try {
    const { roleName, permissions } = await resolvePermissions(req);
    if (holds(permissions, roleName, permission)) return next();

    if (!isEnforced()) {
      logger.warn(
        `[rbac] would DENY ${permission} | user=${req.user?.id || '?'} role=${roleName || 'none'} (RBAC_ENFORCED off)`,
      );
      return next();
    }
    logger.info(`[rbac] denied ${permission} | user=${req.user?.id || '?'} role=${roleName || 'none'}`);
    return res.status(403).json({ message: `Forbidden: missing permission ${permission}` });
  } catch (err) {
    logger.error(`[rbac] check failed for ${permission}: ${err.message}`);
    // Fail closed only when enforcement is on.
    if (isEnforced()) return res.status(403).json({ message: 'Forbidden' });
    return next();
  }
};

module.exports = requirePermission;
