const AuditSeal = require('../models/auditSeal.model');
const AuditLog = require('../models/audit.model');
const { contentHashOf, sha256 } = require('../models/plugins/hashChain');
const logger = require('../middlewheres/logger');

/**
 * Seals audit rows into tamper-evident ranges, and verifies existing seals.
 *
 * The sealer is a single-writer job (registered in queue/scheduler.js as a
 * BullMQ repeatable, so exactly one instance runs it regardless of how many
 * app servers are up). Everything here is idempotent: sealing twice over the
 * same rows is a no-op, because a seal always starts from the last sealed
 * sequence.
 */

const CHAIN_KEY = 'audit';

// Cap per run so a backlog can't produce one enormous seal that takes minutes.
const MAX_ROWS_PER_SEAL = 5000;

/**
 * Fold a list of content hashes into a single root. A plain ordered fold rather
 * than a full Merkle tree: we only ever verify whole ranges, never prove a
 * single row's membership, so a tree would add structure we never use.
 */
function rootOf(hashes) {
  return hashes.reduce((acc, h) => sha256(acc + h), '');
}

function sealHashOf({ prevSealHash, rootHash, fromSeq, toSeq }) {
  return sha256(`${prevSealHash || ''}|${rootHash}|${fromSeq}|${toSeq}`);
}

/**
 * Seal every audit row written since the last seal.
 *
 * @returns {Promise<{ sealed: number, fromSeq: number|null, toSeq: number|null }>}
 */
async function sealPending() {
  const last = await AuditSeal.findOne({ chainKey: CHAIN_KEY }).sort({ toSeq: -1 }).lean();
  const startAfter = last ? last.toSeq : 0;

  // Only seal rows that were actually stamped. An unstamped row (the chain
  // stamp failed at write time) is reported by the verifier rather than
  // silently folded in, so a gap always means something worth looking at.
  const rows = await AuditLog.find({ seq: { $gt: startAfter }, contentHash: { $ne: null } })
    .sort({ seq: 1 })
    .limit(MAX_ROWS_PER_SEAL)
    .select('seq contentHash')
    .lean();

  if (!rows.length) return { sealed: 0, fromSeq: null, toSeq: null };

  const fromSeq = rows[0].seq;
  const toSeq = rows[rows.length - 1].seq;
  const rootHash = rootOf(rows.map((r) => r.contentHash));
  const prevSealHash = last ? last.sealHash : null;

  const seal = await AuditSeal.create({
    chainKey: CHAIN_KEY,
    fromSeq,
    toSeq,
    rowCount: rows.length,
    rootHash,
    prevSealHash,
    sealHash: sealHashOf({ prevSealHash, rootHash, fromSeq, toSeq }),
  });

  // Mark the covered rows. This is the one permitted mutation on audit rows and
  // it touches only bookkeeping, never content — so it cannot change any hash.
  await AuditLog.updateMany(
    { seq: { $gte: fromSeq, $lte: toSeq } },
    { $set: { sealId: seal._id } },
    { allowMutation: true }
  );

  logger.info(`[audit-seal] sealed ${rows.length} rows (${fromSeq}–${toSeq})`);
  return { sealed: rows.length, fromSeq, toSeq };
}

/**
 * Verify the whole chain: every row's content hash, every seal's root, and the
 * links between seals.
 *
 * @param {Object} [opts]
 * @param {number} [opts.fromSeq=0]  verify only from this sequence onward
 * @returns {Promise<{ ok: boolean, checked: number, problems: Array }>}
 */
async function verifyChain({ fromSeq = 0 } = {}) {
  const problems = [];
  let checked = 0;

  const seals = await AuditSeal.find({ chainKey: CHAIN_KEY, toSeq: { $gt: fromSeq } })
    .sort({ fromSeq: 1 })
    .lean();

  let expectedPrev = null;
  let expectedNextSeq = null;

  for (const seal of seals) {
    // Seals must tile the sequence space without gaps or overlaps.
    if (expectedNextSeq !== null && seal.fromSeq !== expectedNextSeq) {
      problems.push({
        type: 'seal_gap',
        detail: `seal ${seal._id} starts at ${seal.fromSeq}, expected ${expectedNextSeq}`,
      });
    }
    // Each seal must link to its predecessor.
    if (expectedPrev !== null && seal.prevSealHash !== expectedPrev) {
      problems.push({
        type: 'seal_link_broken',
        detail: `seal ${seal._id} claims prev ${seal.prevSealHash}, actual ${expectedPrev}`,
      });
    }

    const rows = await AuditLog.find({ seq: { $gte: seal.fromSeq, $lte: seal.toSeq } })
      .sort({ seq: 1 })
      .lean();

    if (rows.length !== seal.rowCount) {
      problems.push({
        type: 'row_count_mismatch',
        detail: `seal ${seal._id} covers ${seal.rowCount} rows, found ${rows.length} — rows deleted or inserted`,
      });
    }

    // Recompute each row's content hash from its current stored content.
    const hashes = [];
    for (const row of rows) {
      const recomputed = contentHashOf(row);
      if (recomputed !== row.contentHash) {
        problems.push({
          type: 'row_modified',
          seq: row.seq,
          resourceId: row.resourceId,
          detail: `row ${row.seq} content no longer matches its hash`,
        });
      }
      hashes.push(row.contentHash);
      checked += 1;
    }

    const recomputedRoot = rootOf(hashes);
    if (recomputedRoot !== seal.rootHash) {
      problems.push({
        type: 'root_mismatch',
        detail: `seal ${seal._id} root does not match its rows`,
      });
    }

    expectedPrev = seal.sealHash;
    expectedNextSeq = seal.toSeq + 1;
  }

  // Rows written but never stamped — not evidence of tampering, but they sit
  // outside the guarantee, so they are always reported.
  const unstamped = await AuditLog.countDocuments({ seq: null });
  if (unstamped > 0) {
    problems.push({
      type: 'unstamped_rows',
      detail: `${unstamped} audit rows carry no sequence and are outside the chain`,
    });
  }

  return { ok: problems.length === 0, checked, problems };
}

module.exports = { sealPending, verifyChain, CHAIN_KEY };
