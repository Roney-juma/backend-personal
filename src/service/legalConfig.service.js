const LegalConfig = require('../models/legalConfig.model');
const cache = require('../cache');
const ApiError = require('../utils/ApiError');
const logger = require('../middlewheres/logger');
const {
  DEFAULT_LIMITATION_PERIODS,
  DEFAULT_RESERVING_SCHEDULE,
  DEFAULT_AUTHORITY_MATRIX,
  DEFAULT_ESCALATION_CHAIN,
  DEFAULT_EVENT_TYPES,
  DEFAULT_REMINDER_OFFSETS,
} = require('../constants/legal.constants');

/**
 * Reads the per-tenant Legal configuration.
 *
 * Every threshold in the module — authority bands, limitation periods,
 * reserving schedule, reminder ladder, escalation chain — is tenant data, per
 * spec §32. Nothing in the module may hard-code one insurer's process, so this
 * is the only place config is resolved and everything else goes through it.
 *
 * Cached briefly: config is read on virtually every legal request but changes
 * rarely, and a stale read for 60 seconds after an edit is harmless. Writes
 * invalidate the entry immediately, so the window only applies to edits made in
 * another process.
 */

const CACHE_TTL_SECONDS = 60;
const cacheKey = (companyId) => `legal:config:${companyId}`;

/**
 * Get a tenant's config, creating it from defaults on first access.
 *
 * @param {*} companyId
 * @returns {Promise<Object>} lean config document
 */
async function get(companyId) {
  if (!companyId) throw new ApiError(400, 'A company is required to read legal configuration');

  return cache.wrap(
    cacheKey(companyId),
    async () => {
      let config = await LegalConfig.findOne({ company: companyId }).lean();
      if (!config) {
        config = await ensureForCompany(companyId);
      }
      return normalise(config);
    },
    CACHE_TTL_SECONDS
  );
}

/**
 * Create a tenant's config from the seeded defaults if it does not exist yet.
 * Idempotent — safe to call from the seeder and from get().
 */
async function ensureForCompany(companyId) {
  const existing = await LegalConfig.findOne({ company: companyId }).lean();
  if (existing) return existing;

  try {
    const created = await LegalConfig.create({ company: companyId });
    logger.info(`[legal-config] seeded defaults for company ${companyId}`);
    return created.toObject();
  } catch (err) {
    // Unique index on `company` — another process won the race, which is fine.
    if (err.code === 11000) {
      return LegalConfig.findOne({ company: companyId }).lean();
    }
    throw err;
  }
}

/**
 * Update a tenant's config. Bumps `version` (see the model's pre-save hook), so
 * approvals that snapshotted an earlier version stay explicable.
 */
async function update(companyId, changes, actor = null) {
  const config = await LegalConfig.findOne({ company: companyId });
  if (!config) {
    await ensureForCompany(companyId);
    return update(companyId, changes, actor);
  }

  // `company` and `version` are not caller-settable: one is the tenant identity,
  // the other is derived.
  const { company, version, _id, ...safe } = changes || {};
  Object.assign(config, safe);
  config.updatedBy = actor?._id || actor?.id || null;
  await config.save();

  await cache.del(cacheKey(companyId));
  logger.info(`[legal-config] company ${companyId} updated to version ${config.version}`);
  return normalise(config.toObject());
}

// ── Focused readers ──────────────────────────────────────────────────────────

/**
 * Limitation period in months for a third-party claim type.
 *
 * Falls back to the tightest configured period rather than to "unlimited" when a
 * type is unconfigured: under-estimating a deadline produces an early warning,
 * over-estimating produces a time-barred claim.
 */
async function limitationMonths(companyId, claimType) {
  const config = await get(companyId);
  const periods = config.limitationPeriods || {};
  if (periods[claimType]) return periods[claimType];

  const values = Object.values(periods).filter((v) => Number.isFinite(v) && v > 0);
  const fallback = values.length ? Math.min(...values) : 36;
  logger.warn(
    `[legal-config] no limitation period configured for '${claimType}' on company ${companyId} — ` +
    `falling back to the tightest configured period (${fallback} months)`
  );
  return fallback;
}

/**
 * The reserving band for an injury code, or null when the tenant has not loaded
 * their schedule. Callers must treat null as "ask the user", never as zero.
 */
async function reservingBand(companyId, injuryCode) {
  const config = await get(companyId);
  const band = (config.reservingSchedule || []).find((b) => b.code === injuryCode);
  if (!band) return null;
  // A schedule seeded but never filled in is not a reserve of zero.
  if (!band.defaultMinor && !band.minMinor && !band.maxMinor) return null;
  return band;
}

/**
 * The authority band that governs an amount, with the config version attached so
 * the caller can snapshot it onto the approval record.
 */
async function authorityFor(companyId, amountMinor) {
  const config = await get(companyId);
  const bands = config.authorityMatrix || [];
  const band = bands.find(
    (b) => amountMinor >= b.minMinor && (b.maxMinor === null || b.maxMinor === undefined || amountMinor <= b.maxMinor)
  );
  if (!band) {
    // Better to demand the highest authority than to let an amount through
    // because it fell in a gap someone left in the matrix.
    const highest = bands[bands.length - 1];
    logger.warn(
      `[legal-config] amount ${amountMinor} falls outside company ${companyId}'s authority matrix — ` +
      `requiring the highest configured approver`
    );
    return highest ? { ...highest, configVersion: config.version, outsideMatrix: true } : null;
  }
  return { ...band, configVersion: config.version };
}

/** Reminder offsets for an event type, falling back to the tenant-wide ladder. */
async function reminderOffsetsFor(companyId, eventTypeCode) {
  const config = await get(companyId);
  const type = (config.eventTypes || []).find((t) => t.code === eventTypeCode);
  if (type?.reminderOffsets?.length) return type.reminderOffsets;
  return config.reminderOffsets || [...DEFAULT_REMINDER_OFFSETS];
}

/** The escalation ladder — who gets woken, in order. */
async function escalationChain(companyId) {
  const config = await get(companyId);
  const chain = config.escalationChain || [];
  return [...chain].sort((a, b) => a.rung - b.rung);
}

async function invalidate(companyId) {
  await cache.del(cacheKey(companyId));
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Mongoose Maps do not survive .lean() as plain objects consistently across
 * versions, so flatten them once here rather than at every call site.
 */
function normalise(config) {
  if (!config) return config;
  const out = { ...config };
  for (const key of ['limitationPeriods', 'riskWeights']) {
    if (out[key] instanceof Map) out[key] = Object.fromEntries(out[key]);
  }
  if (out.advocateAllocation?.weights instanceof Map) {
    out.advocateAllocation = {
      ...out.advocateAllocation,
      weights: Object.fromEntries(out.advocateAllocation.weights),
    };
  }
  // A tenant created before a default existed still gets sane values.
  out.limitationPeriods = out.limitationPeriods || { ...DEFAULT_LIMITATION_PERIODS };
  out.reservingSchedule = out.reservingSchedule?.length ? out.reservingSchedule : [...DEFAULT_RESERVING_SCHEDULE];
  out.authorityMatrix = out.authorityMatrix?.length ? out.authorityMatrix : [...DEFAULT_AUTHORITY_MATRIX];
  out.escalationChain = out.escalationChain?.length ? out.escalationChain : [...DEFAULT_ESCALATION_CHAIN];
  out.eventTypes = out.eventTypes?.length ? out.eventTypes : [...DEFAULT_EVENT_TYPES];
  return out;
}

module.exports = {
  get,
  update,
  ensureForCompany,
  invalidate,
  limitationMonths,
  reservingBand,
  authorityFor,
  reminderOffsetsFor,
  escalationChain,
};
