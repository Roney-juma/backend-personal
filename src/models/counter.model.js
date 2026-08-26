const mongoose = require('mongoose');

/**
 * Atomic sequence counters for human-facing reference numbers.
 *
 * The existing VendorInvoice numbering uses countDocuments(), which races: two
 * concurrent saves both read N and both write N+1. For an invoice that is an
 * annoyance. For a legal case number — which is quoted in court filings and on
 * correspondence with opposing counsel — a duplicate is a real problem, so legal
 * references come from here instead.
 *
 * One document per (scope, period). `findOneAndUpdate($inc, upsert)` is a single
 * atomic operation on the primary, so concurrent callers are serialised by the
 * database rather than by luck.
 */
const counterSchema = new mongoose.Schema(
  {
    // e.g. "LEG:507f1f77bcf86cd799439011:2026" — sequence per tenant per year, so
    // numbering restarts annually and never leaks volume between insurers.
    key: { type: String, required: true, unique: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);

/**
 * Increment and return the next value for a key. Never returns the same number
 * twice, including across processes and instances.
 *
 * @param {string} key
 * @returns {Promise<number>}
 */
counterSchema.statics.next = async function next(key) {
  const doc = await this.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
  return doc.seq;
};

/**
 * Build a formatted reference: PREFIX-YYYY-NNNNN.
 *
 * @param {Object}  opts
 * @param {string}  opts.prefix     'LEG' | 'TPC' | 'REC' …
 * @param {*}       [opts.company]  tenant id — sequences never span insurers
 * @param {Date}    [opts.on]       date the reference belongs to (defaults to now)
 * @param {number}  [opts.pad=5]
 * @returns {Promise<string>}
 */
counterSchema.statics.nextReference = async function nextReference({ prefix, company, on, pad = 5 }) {
  const date = on || new Date();
  const year = date.getFullYear();
  const scope = company ? String(company) : 'global';
  const seq = await this.next(`${prefix}:${scope}:${year}`);
  return `${prefix}-${year}-${String(seq).padStart(pad, '0')}`;
};

module.exports = mongoose.model('Counter', counterSchema);
