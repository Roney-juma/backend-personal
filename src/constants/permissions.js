/**
 * Canonical RBAC permission catalog — the single source of truth for the backend.
 * The frontend mirrors these exact strings in `frontend_ave/src/lib/permissions.ts`.
 *
 * Convention: UPPER_SNAKE, `ACTION_SUBJECT`. A `VIEW_*` permission gates read
 * access / page visibility; the others gate a specific mutation. Keep this in
 * sync with `role-permissions.json` (which the roles UI reads for its picker).
 */

// ── Grouped catalog (drives the role-editor UI) ──────────────────────────────
const GROUPS = {
  'Users & Roles': [
    'VIEW_USERS', 'CREATE_USER', 'UPDATE_USER', 'DELETE_USER',
    'VIEW_ROLES', 'CREATE_ROLE', 'UPDATE_ROLE', 'DELETE_ROLE', 'ASSIGN_ROLE',
  ],
  'Claims': [
    'VIEW_CLAIMS', 'CREATE_CLAIM', 'UPDATE_CLAIM', 'DELETE_CLAIM',
    'APPROVE_CLAIM', 'REJECT_CLAIM', 'AWARD_CLAIM', 'COMPLETE_CLAIM',
    'GENERATE_CLAIM_LINK', 'VIEW_CLAIM_ANALYTICS',
  ],
  'Cash in Lieu (Self-Repair)': [
    'VIEW_SELF_REPAIR', 'APPROVE_SELF_REPAIR', 'REJECT_SELF_REPAIR', 'PAY_SELF_REPAIR',
  ],
  'Glass Claims': [
    'VIEW_GLASS_CLAIMS', 'APPROVE_GLASS_CLAIM', 'ASSIGN_GLASS_SUPPLIER', 'COMPLETE_GLASS_CLAIM',
  ],
  'Customers': [
    'VIEW_CUSTOMERS', 'CREATE_CUSTOMER', 'UPDATE_CUSTOMER', 'IMPORT_CUSTOMERS',
  ],
  'Garages': [
    'VIEW_GARAGES', 'CREATE_GARAGE', 'UPDATE_GARAGE', 'DELETE_GARAGE',
  ],
  'Assessors': [
    'VIEW_ASSESSORS', 'CREATE_ASSESSOR', 'UPDATE_ASSESSOR', 'DELETE_ASSESSOR',
  ],
  'Suppliers': [
    'VIEW_SUPPLIERS', 'CREATE_SUPPLIER', 'UPDATE_SUPPLIER', 'DELETE_SUPPLIER',
  ],
  'Investigations': [
    'VIEW_INVESTIGATORS', 'CREATE_INVESTIGATOR', 'UPDATE_INVESTIGATOR', 'DELETE_INVESTIGATOR',
    'ASSIGN_INVESTIGATION', 'REVIEW_INVESTIGATION', 'FLAG_FRAUD',
  ],
  'Vendor Invoices': [
    'VIEW_VENDOR_INVOICES', 'APPROVE_VENDOR_INVOICE', 'REJECT_VENDOR_INVOICE', 'PAY_VENDOR_INVOICE',
  ],
  'Claim Types': [
    'VIEW_CLAIM_TYPES', 'CREATE_CLAIM_TYPE', 'UPDATE_CLAIM_TYPE', 'DELETE_CLAIM_TYPE',
  ],
  'Support': [
    'VIEW_SUPPORT', 'MANAGE_SUPPORT',
  ],
  'Reports & Audit': [
    'VIEW_AUDIT_LOGS', 'VIEW_REPORTS', 'EXPORT_REPORTS',
  ],
};

// Flat list of every permission string.
const ALL_PERMISSIONS = Object.values(GROUPS).flat();

// Named constants (P.APPROVE_CLAIM === 'APPROVE_CLAIM') — prevents route typos.
const P = Object.freeze(
  ALL_PERMISSIONS.reduce((acc, perm) => {
    acc[perm] = perm;
    return acc;
  }, {}),
);

// A role whose (normalised) name is one of these is treated as unrestricted.
const ADMIN_ROLE_NAMES = new Set(['admin', 'superadmin', 'super admin']);

/**
 * Default role templates seeded per tenant (see scripts/seed-roles.js). Super Admin
 * is global and gets everything via ensureSuperAdminRole(); these are starting
 * points a tenant can clone/edit.
 */
const DEFAULT_ROLES = {
  'Claims Manager': [
    'VIEW_CLAIMS', 'CREATE_CLAIM', 'UPDATE_CLAIM', 'APPROVE_CLAIM', 'REJECT_CLAIM',
    'AWARD_CLAIM', 'COMPLETE_CLAIM', 'GENERATE_CLAIM_LINK', 'VIEW_CLAIM_ANALYTICS',
    'VIEW_SELF_REPAIR', 'APPROVE_SELF_REPAIR', 'REJECT_SELF_REPAIR',
    'VIEW_GLASS_CLAIMS', 'APPROVE_GLASS_CLAIM', 'ASSIGN_GLASS_SUPPLIER', 'COMPLETE_GLASS_CLAIM',
    'VIEW_CUSTOMERS', 'VIEW_GARAGES', 'VIEW_ASSESSORS', 'VIEW_SUPPLIERS', 'VIEW_CLAIM_TYPES',
  ],
  'Finance': [
    'VIEW_CLAIMS', 'VIEW_CLAIM_ANALYTICS',
    'VIEW_SELF_REPAIR', 'PAY_SELF_REPAIR',
    'VIEW_VENDOR_INVOICES', 'APPROVE_VENDOR_INVOICE', 'REJECT_VENDOR_INVOICE', 'PAY_VENDOR_INVOICE',
    'VIEW_REPORTS', 'EXPORT_REPORTS',
  ],
  'Operations': [
    'VIEW_CLAIMS', 'VIEW_CUSTOMERS', 'CREATE_CUSTOMER', 'UPDATE_CUSTOMER', 'IMPORT_CUSTOMERS',
    'VIEW_GARAGES', 'CREATE_GARAGE', 'UPDATE_GARAGE',
    'VIEW_ASSESSORS', 'CREATE_ASSESSOR', 'UPDATE_ASSESSOR',
    'VIEW_SUPPLIERS', 'CREATE_SUPPLIER', 'UPDATE_SUPPLIER',
    'VIEW_CLAIM_TYPES', 'VIEW_SUPPORT', 'MANAGE_SUPPORT',
  ],
  'Investigator Manager': [
    'VIEW_CLAIMS', 'FLAG_FRAUD',
    'VIEW_INVESTIGATORS', 'CREATE_INVESTIGATOR', 'UPDATE_INVESTIGATOR', 'DELETE_INVESTIGATOR',
    'ASSIGN_INVESTIGATION', 'REVIEW_INVESTIGATION',
  ],
  'Read Only': ALL_PERMISSIONS.filter((p) => p.startsWith('VIEW_')),
};

module.exports = { GROUPS, ALL_PERMISSIONS, P, ADMIN_ROLE_NAMES, DEFAULT_ROLES };
