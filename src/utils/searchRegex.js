/**
 * Build a case-insensitive regex for a user-typed search term.
 *
 * Escaping is the whole point. A reference like "TPC-2026/0041" or a firm named
 * "Otieno & Co (Advocates)" contains characters that are regex operators, and an
 * unescaped "(" is a syntax error that reaches the user as a 500 rather than an
 * empty result. A lone "." would otherwise match every record in the tenant.
 *
 * Returns null for an empty term so callers can leave the filter alone.
 */
const searchRegex = (term) => {
  const value = String(term ?? '').trim();
  if (!value) return null;
  // Cap the length: a very long term is never a real search, and the regex cost
  // is paid per document scanned.
  return new RegExp(value.slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
};

module.exports = { searchRegex };
