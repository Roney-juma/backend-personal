// Microsoft Entra ID (Azure AD) OIDC configuration — all env-driven so an
// enterprise client plugs in their own tenant without code changes. SSO is
// inactive until ENTRA_TENANT_ID / ENTRA_CLIENT_ID / ENTRA_CLIENT_SECRET are set.
const entraConfig = {
  tenantId: process.env.ENTRA_TENANT_ID,
  clientId: process.env.ENTRA_CLIENT_ID,
  clientSecret: process.env.ENTRA_CLIENT_SECRET,
  // Where Entra redirects back to (must match the app registration's redirect URI).
  redirectUri: process.env.ENTRA_REDIRECT_URI, // e.g. https://insurance-api.aveafricasolutions.com/auth/sso/entra/callback
  // Where the backend sends the browser after issuing the app token (the portal).
  postLoginRedirect: process.env.ENTRA_POST_LOGIN_REDIRECT, // e.g. https://admin.aveafrica.com/sso/callback
  // Optional guardrails for just-in-time provisioning.
  allowedDomains: (process.env.ENTRA_ALLOWED_DOMAINS || '')
    .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
  defaultRoleId: process.env.ENTRA_DEFAULT_ROLE_ID || undefined,
  // Auto-create a local user on first SSO login (default on). If off, the user
  // must already exist (pre-provisioned) or login is rejected.
  autoProvision: (process.env.ENTRA_AUTO_PROVISION || 'true').toLowerCase() !== 'false',
};

// The OIDC issuer discovery URL for this tenant (v2.0 endpoint).
const issuerUrl = () =>
  entraConfig.tenantId
    ? `https://login.microsoftonline.com/${entraConfig.tenantId}/v2.0`
    : null;

const isConfigured = () =>
  Boolean(entraConfig.tenantId && entraConfig.clientId && entraConfig.clientSecret && entraConfig.redirectUri);

module.exports = { entraConfig, issuerUrl, isConfigured };
