const { Issuer, generators } = require('openid-client');
const User = require('../models/users.model');
const tokenService = require('./token.service');
const { entraConfig, issuerUrl, isConfigured } = require('../config/entra');
const logger = require('../middlewheres/logger');

// Discover the Entra tenant + build the OIDC client once, then reuse.
let clientPromise = null;
const getClient = () => {
  if (!isConfigured()) throw new Error('Entra SSO is not configured');
  if (!clientPromise) {
    clientPromise = Issuer.discover(issuerUrl()).then((issuer) =>
      new issuer.Client({
        client_id: entraConfig.clientId,
        client_secret: entraConfig.clientSecret,
        redirect_uris: [entraConfig.redirectUri],
        response_types: ['code'],
      })
    ).catch((err) => {
      clientPromise = null; // allow retry on transient discovery failure
      throw err;
    });
  }
  return clientPromise;
};

// Step 1: build the Entra authorization URL + the one-time secrets the callback needs.
const beginLogin = async () => {
  const client = await getClient();
  const codeVerifier = generators.codeVerifier();
  const codeChallenge = generators.codeChallenge(codeVerifier);
  const state = generators.state();
  const nonce = generators.nonce();

  const url = client.authorizationUrl({
    scope: 'openid profile email',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  });

  return { url, codeVerifier, state, nonce };
};

// Find or (optionally) create the local user that maps to an Entra identity.
const provisionUser = async (claims) => {
  const email = (claims.email || claims.preferred_username || '').toLowerCase();
  const oid = claims.oid;
  const tid = claims.tid;
  if (!email) throw new Error('Entra token did not include an email/UPN');

  if (entraConfig.allowedDomains.length) {
    const domain = email.split('@')[1] || '';
    if (!entraConfig.allowedDomains.includes(domain)) {
      throw new Error(`Domain not allowed for SSO: ${domain}`);
    }
  }

  // Match by stable Entra object id first, then by email (to link existing accounts).
  let user = await User.findOne({ ssoObjectId: oid });
  if (!user) user = await User.findOne({ email });

  if (!user) {
    if (!entraConfig.autoProvision) {
      throw new Error('No account exists for this user and auto-provisioning is disabled');
    }
    user = new User({
      email,
      username: email,
      fullName: claims.name || email,
      authProvider: 'entra',
      ssoObjectId: oid,
      ssoTenantId: tid,
      role: entraConfig.defaultRoleId || undefined,
      active: true,
    });
  } else {
    // Link / refresh SSO identity on an existing account.
    user.authProvider = 'entra';
    user.ssoObjectId = oid;
    user.ssoTenantId = tid;
    if (!user.fullName && claims.name) user.fullName = claims.name;
  }

  if (!user.active) throw new Error('Account is deactivated');

  user.lastLogin = new Date();
  await user.save();
  return user;
};

// Step 2: exchange the code, validate the ID token, provision, and issue the app token.
const completeLogin = async (params, { codeVerifier, state, nonce }) => {
  const client = await getClient();
  const tokenSet = await client.callback(entraConfig.redirectUri, params, {
    code_verifier: codeVerifier,
    state,
    nonce,
  });
  const claims = tokenSet.claims();
  const user = await provisionUser(claims);
  // SSO provisions insurer-portal Users — mint a company-user (tenant) token.
  const tokens = tokenService.generateCompanyUserToken(user);
  logger.info('Entra SSO login', { email: user.email, oid: claims.oid });
  return { user, tokens };
};

module.exports = { beginLogin, completeLogin, provisionUser, isConfigured };
