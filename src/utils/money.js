/**
 * Minor-unit money helpers for the Legal module.
 *
 * Legal matters accrue interest over years on nine-figure sums, where IEEE-754
 * drift becomes visible and — worse — disputable. Every amount the Legal module
 * stores is therefore an INTEGER number of minor units (cents), and conversion
 * happens only at the API edge.
 *
 * Scope is deliberately limited to Legal. Existing claim money fields stay as
 * plain Numbers; there is no migration and no mixed arithmetic — anything
 * crossing the boundary goes through toMinor()/toMajor() explicitly.
 *
 * Field naming convention: a field holding minor units ends in `Minor`. If it
 * does not end in `Minor`, it is not cents.
 */

const ApiError = require('./ApiError');

// Beyond this, integer arithmetic in JS stops being exact (2^53 - 1 minor units
// is roughly 90 trillion KES). Anything approaching it is a data-entry error,
// not a real reserve, so we reject rather than silently lose precision.
const MAX_SAFE_MINOR = Number.MAX_SAFE_INTEGER;

const DEFAULT_CURRENCY = 'KES';
const MINOR_PER_MAJOR = 100;

/**
 * Convert a major-unit amount (what a user types: 4500000.50) to minor units.
 * Rounds half away from zero, which is what a person doing this by hand expects.
 *
 * @param {number|string} major
 * @returns {number} integer minor units
 */
function toMinor(major) {
  if (major === null || major === undefined || major === '') {
    throw new ApiError(400, 'Amount is required');
  }
  const n = typeof major === 'string' ? Number(major.replace(/[\s,]/g, '')) : Number(major);
  if (!Number.isFinite(n)) {
    throw new ApiError(400, `Not a valid amount: ${major}`);
  }
  // Scale before rounding so 0.1 + 0.2 style drift can't survive the conversion.
  const scaled = Math.round(Math.abs(n) * MINOR_PER_MAJOR) * Math.sign(n);
  assertSafe(scaled);
  return scaled;
}

/**
 * Convert minor units back to a major-unit Number for API responses.
 * Never use the result for further arithmetic — do the maths in minor units and
 * convert once, at the edge.
 *
 * @param {number} minor
 * @returns {number}
 */
function toMajor(minor) {
  if (minor === null || minor === undefined) return null;
  assertInteger(minor);
  return minor / MINOR_PER_MAJOR;
}

/**
 * Format minor units for display / notification copy: "KSh 4,500,000.50".
 *
 * @param {number} minor
 * @param {string} [currency]
 * @returns {string}
 */
function formatMinor(minor, currency = DEFAULT_CURRENCY) {
  if (minor === null || minor === undefined) return '—';
  assertInteger(minor);
  const symbol = currency === 'KES' ? 'KSh' : currency;
  const major = Math.abs(minor) / MINOR_PER_MAJOR;
  const body = major.toLocaleString('en-KE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${minor < 0 ? '-' : ''}${symbol} ${body}`;
}

/**
 * Sum minor-unit amounts safely. Rejects the whole sum if any term is not an
 * integer — a silent float in a reserve total is exactly the failure this module
 * exists to prevent.
 *
 * @param {number[]} amounts
 * @returns {number}
 */
function sumMinor(amounts) {
  const total = (amounts || []).reduce((acc, a) => {
    assertInteger(a);
    return acc + a;
  }, 0);
  assertSafe(total);
  return total;
}

/**
 * Apply a liability apportionment to a quantum figure.
 *
 * Percentages are whole or fractional percents (80, 82.5). Rounding is half away
 * from zero, applied once at the end, so a claim apportioned 1/3 never loses a
 * cent to repeated rounding.
 *
 * @param {number} minor   gross quantum in minor units
 * @param {number} percent share of liability, 0–100
 * @returns {number}
 */
function applyPercent(minor, percent) {
  assertInteger(minor);
  const p = Number(percent);
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    throw new ApiError(400, `Liability share must be between 0 and 100, got ${percent}`);
  }
  const result = Math.round(Math.abs(minor) * p) / 100 * Math.sign(minor);
  const rounded = Math.round(result);
  assertSafe(rounded);
  return rounded;
}

/**
 * Cap an exposure at a policy limit. Returns the capped amount and whether the
 * limit actually bit, because "we are at limit" changes the insurer's position
 * materially and the caller almost always needs to surface it.
 *
 * @param {number} minor
 * @param {number|null} limitMinor  null / undefined = unlimited cover
 * @returns {{ amountMinor: number, limitApplied: boolean, excessMinor: number }}
 */
function capAtLimit(minor, limitMinor) {
  assertInteger(minor);
  if (limitMinor === null || limitMinor === undefined) {
    return { amountMinor: minor, limitApplied: false, excessMinor: 0 };
  }
  assertInteger(limitMinor);
  if (minor <= limitMinor) {
    return { amountMinor: minor, limitApplied: false, excessMinor: 0 };
  }
  return { amountMinor: limitMinor, limitApplied: true, excessMinor: minor - limitMinor };
}

function assertInteger(v) {
  if (!Number.isInteger(v)) {
    throw new ApiError(500, `Money value must be integer minor units, got ${v}`);
  }
  assertSafe(v);
}

function assertSafe(v) {
  if (!Number.isSafeInteger(v) || Math.abs(v) > MAX_SAFE_MINOR) {
    throw new ApiError(400, 'Amount is outside the range this system can represent exactly');
  }
}

module.exports = {
  toMinor,
  toMajor,
  formatMinor,
  sumMinor,
  applyPercent,
  capAtLimit,
  DEFAULT_CURRENCY,
  MINOR_PER_MAJOR,
};
