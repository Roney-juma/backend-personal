const jwt = require('jsonwebtoken');
const ssoService = require('../service/sso.service');
const { entraConfig, isConfigured } = require('../config/entra');
const logger = require('../middlewheres/logger');

const TX_COOKIE = 'sso_tx';
const TX_SECRET = process.env.ENCRYPTION_SECRET || process.env.JWT_KEY || 'sso-tx-secret';

const txCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax', // allows the top-level GET redirect back from Entra to carry the cookie
  maxAge: 10 * 60 * 1000,
  path: '/auth/sso',
};

// GET /auth/sso/entra/status — lets the portal decide whether to show the SSO button.
const status = (req, res) => {
  res.status(200).json({ enabled: isConfigured(), provider: 'entra' });
};

// GET /auth/sso/entra/login — start the OIDC flow.
const login = async (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({ message: 'Entra SSO is not configured' });
  }
  try {
    const { url, codeVerifier, state, nonce } = await ssoService.beginLogin();
    // Stash the one-time secrets in a signed, httpOnly cookie (stateless — no session store).
    const tx = jwt.sign({ codeVerifier, state, nonce }, TX_SECRET, { expiresIn: '10m' });
    res.cookie(TX_COOKIE, tx, txCookieOptions);
    res.redirect(url);
  } catch (err) {
    logger.error('SSO login error: %s', err.message);
    res.status(500).json({ message: 'Failed to start SSO login' });
  }
};

// GET /auth/sso/entra/callback — Entra redirects here with ?code&state.
const callback = async (req, res) => {
  const failRedirect = (reason) => {
    const base = entraConfig.postLoginRedirect || '/';
    const sep = base.includes('#') ? '&' : '#';
    return res.redirect(`${base}${sep}sso_error=${encodeURIComponent(reason)}`);
  };

  try {
    const txToken = req.cookies ? req.cookies[TX_COOKIE] : undefined;
    if (!txToken) return failRedirect('Login session expired. Please try again.');

    let tx;
    try {
      tx = jwt.verify(txToken, TX_SECRET);
    } catch {
      return failRedirect('Invalid login session');
    }
    res.clearCookie(TX_COOKIE, { path: '/auth/sso' });

    const params = req.query; // openid-client reads code/state/error from here
    if (params.error) return failRedirect(params.error_description || params.error);
    if (params.state !== tx.state) return failRedirect('State mismatch');

    const { user, tokens } = await ssoService.completeLogin(params, {
      codeVerifier: tx.codeVerifier,
      state: tx.state,
      nonce: tx.nonce,
    });

    const base = entraConfig.postLoginRedirect;
    if (!base) return res.status(200).json({ user, tokens }); // API-only fallback

    // Hand the app token to the SPA via the URL fragment (not sent to servers/logs).
    const payload = Buffer.from(JSON.stringify({ token: tokens, user })).toString('base64url');
    return res.redirect(`${base}#sso=${payload}`);
  } catch (err) {
    logger.error('SSO callback error: %s', err.message);
    return failRedirect('Sign-in failed');
  }
};

module.exports = { status, login, callback };
