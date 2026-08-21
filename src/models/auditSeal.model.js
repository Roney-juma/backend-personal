const mongoose = require('mongoose');
const appendOnly = require('./plugins/appendOnly');

/**
 * A tamper-evidence checkpoint over a contiguous range of audit rows.
 *
 * Each seal covers rows [fromSeq, toSeq] of one chain, stores the Merkle-style
 * root of their content hashes, and links to the previous seal. Together the
 * seals detect what per-row hashes alone cannot: rows inserted after the fact,
 * rows deleted, or rows reordered.
 *
 * Written only by the sealer job (queue/scheduler.js), one writer at a time.
 * Append-only: a seal is never rewritten, because rewriting one is exactly what
 * an attacker covering their tracks would need to do.
 */
const auditSealSchema = new mongoose.Schema(
  {
    chainKey: { type: String, required: true, index: true },

    fromSeq:  { type: Number, required: true },
    toSeq:    { type: Number, required: true },
    rowCount: { type: Number, required: true },

    // Root over this range's contentHashes, in sequence order.
    rootHash: { type: String, required: true },

    // Hash of the preceding seal, forming the chain across ranges. null on the
    // first seal of a chain.
    prevSealHash: { type: String, default: null },

    // sha256(prevSealHash + rootHash + fromSeq + toSeq) — what the next seal links to.
    sealHash: { type: String, required: true },

    sealedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// The sealer always needs the newest seal for a chain.
auditSealSchema.index({ chainKey: 1, toSeq: -1 });

auditSealSchema.plugin(appendOnly);

module.exports = mongoose.model('AuditSeal', auditSealSchema);
