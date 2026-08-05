const logger = require('../middlewheres/logger');

// Models whose indexes are reconciled with the schema on every startup.
//
// Model.syncIndexes() CREATES indexes declared in the schema that are missing AND
// DROPS any index present in the database that the schema no longer declares
// (except the default _id index). List ONLY models whose schema fully describes
// their intended indexes — otherwise a deliberately DB-only index would be dropped.
const MODELS = [
  require('../models/roles.model'),
];

/**
 * Reconcile indexes so every environment self-heals to the current schema on boot:
 * a fresh DB gets the declared indexes created; an existing DB additionally has
 * legacy indexes dropped — e.g. the old UNIQUE roles.{ name: 1 } that predates the
 * per-tenant { company, name } index and blocks a second company's "Super Admin".
 *
 * Never throws: an index-sync failure is logged and boot continues, so a transient
 * issue (or a concurrent sync from another instance) can't take the app down.
 */
async function ensureIndexes() {
  for (const Model of MODELS) {
    try {
      const dropped = await Model.syncIndexes();
      const droppedNote = Array.isArray(dropped) && dropped.length ? ` (dropped: ${dropped.join(', ')})` : '';
      logger.info(`[indexes] synced ${Model.modelName}${droppedNote}`);
    } catch (err) {
      logger.warn(`[indexes] syncIndexes failed for ${Model.modelName}: ${err.message}`);
    }
  }
}

module.exports = { ensureIndexes };
