const crypto = require('crypto');

/**
 * Tamper-evidence for append-only records.
 *
 * Spec §23 requires the legal audit record to be immutable. Immutability at the
 * application layer (see plugins/appendOnly.js) stops our own code from editing
 * history; it does nothing about someone with direct database access. This
 * plugin makes such edits *detectable*.
 *
 * Design note — why not a naive prevHash chain:
 *   The obvious approach is "read the last row's hash, chain onto it, insert".
 *   Under concurrent inserts two writers read the same head and produce two rows
 *   claiming the same predecessor, which silently forks the chain. Serialising
 *   every audit write behind a lock would make audit logging a bottleneck on
 *   every request, which is worse.
 *
 * So the work is split:
 *   1. On insert (hot path, fully concurrent) each row gets an atomic sequence
 *      number and a `contentHash` over its own canonical content. Cheap, no
 *      contention, and enough to detect any edit to a single row.
 *   2. Periodically (see queue/scheduler.js) a single sealer walks the new rows
 *      in sequence order and writes an AuditSeal covering that range, chained to
 *      the previous seal. Detects insertion, deletion and reordering.
 *
 * Verification is scripts/verify-audit-chain.js.
 */

// Fields excluded from the content hash: mongoose bookkeeping, and the chain
// fields themselves (which are derived from the content, not part of it).
const EXCLUDED = new Set(['_id', '__v', 'contentHash', 'seq', 'sealId', 'createdAt', 'updatedAt']);

/**
 * Deterministic serialisation. Object keys are sorted so two logically identical
 * records always hash identically regardless of insertion order, and values are
 * normalised so an ObjectId and its string form don't produce different hashes.
 */
function canonicalize(value) {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return `d:${value.toISOString()}`;
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    // ObjectId, Decimal128 and friends all serialise stably via toString().
    if (typeof value.toHexString === 'function') return `o:${value.toHexString()}`;
    if (value._bsontype) return `b:${value.toString()}`;
    const keys = Object.keys(value).filter((k) => !EXCLUDED.has(k)).sort();
    return `{${keys.map((k) => `${k}:${canonicalize(value[k])}`).join(',')}}`;
  }
  if (typeof value === 'string') return `s:${value}`;
  if (typeof value === 'number') return `n:${value}`;
  if (typeof value === 'boolean') return `t:${value}`;
  return `x:${String(value)}`;
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Compute the content hash for a plain object or hydrated document.
 * Exported so the verifier can recompute independently of the model layer.
 */
function contentHashOf(doc) {
  const plain = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return sha256(canonicalize(plain));
}

/**
 * @param {import('mongoose').Schema} schema
 * @param {Object} opts
 * @param {string} opts.chainKey  Sequence scope, e.g. 'audit'. One chain per key.
 */
module.exports = function hashChainPlugin(schema, opts = {}) {
  const chainKey = opts.chainKey || 'default';

  schema.add({
    // Monotonic within the chain. Gaps mean deleted rows; the verifier reports them.
    seq:         { type: Number, index: true },
    contentHash: { type: String },
    // Set by the sealer once this row is covered by an AuditSeal.
    sealId:      { type: require('mongoose').Schema.Types.ObjectId, ref: 'AuditSeal', default: null, index: true },
  });

  schema.pre('save', async function stampChain(next) {
    if (!this.isNew) return next();
    try {
      const Counter = require('../counter.model');
      this.seq = await Counter.next(`chain:${chainKey}`);
      this.contentHash = contentHashOf(this);
      return next();
    } catch (err) {
      // A chain-stamping failure must never lose the audit record itself — the
      // row is written unstamped and the verifier reports it as unsealed.
      return next();
    }
  });

  schema.statics.chainKey = () => chainKey;
};

module.exports.contentHashOf = contentHashOf;
module.exports.canonicalize = canonicalize;
module.exports.sha256 = sha256;
