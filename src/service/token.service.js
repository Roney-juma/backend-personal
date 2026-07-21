const jwt = require('jsonwebtoken');
const { TokenIssuer, TokenSecret } = require('../constants/encryption.constants');
const { Encrypt } = require('../utils/encription.js');
const { readPrivateKey } = require('../config/keys');

const privateKey = readPrivateKey();

const GenerateToken = (user) => {
    // Tenant claim: customers/garages/assessors use `company`, suppliers use
    // `insuranceCompany`. A supplier's `company` is its free-text business name
    // (and suppliers have no accountType field), so only ObjectId values — never
    // strings — are accepted as the tenant ref.
    const tenantRef = [user.insuranceCompany, user.company]
        .find(v => v && typeof v === 'object');
    const data = {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        policyNumber: user.policyNumber,
        user_status: user.user_status,
        phone: user.phone,
        is_deleted: user.is_deleted,
        accountType: user.accountType,
        company: tenantRef ? (tenantRef._id || tenantRef) : undefined,
    };

    // const encryptedData = Encrypt(JSON.stringify(data));

    const token = jwt.sign(
        { payload: data },
        {
            key: privateKey.replace(/\\n/gm, '\n'),
            passphrase: TokenSecret,
        },
        {
            issuer: TokenIssuer,
            algorithm: 'RS512',
            expiresIn: '2d', // add dynamic time
            header: { typ: 'Bearer token' },
        }
    );

    return token;
};

const generate = (user) => {
    const data = {
        id: user?._id,
        email: user?.email,
        first_name: user?.first_name,
        middle_name: user?.middle_name,
        last_name: user?.last_name,
        image_url: user?.image_url,
        erp_token: user?.erp_token,
        designation: user?.designation,
        role_ID: user?.role_ID,
        accountType: 'ProviderUser',
    };
    const token = jwt.sign(
        { payload: data },
        {
            key: privateKey.replace(/\\n/gm, '\n'),
            passphrase: TokenSecret,
        },
        {
            issuer: TokenIssuer,
            algorithm: 'RS512',
            expiresIn: '1d',
        }
    );
    return token;
};

const generatePocToken = (user) => {
    const data = {
        id: user?._id,
        email: user?.email,
        name: user?.name,
        image: user?.image,
        company: user?.customer,
        phone:user?.phone,
        designation: user?.designation,
        alt_phone: user?.alt_phone,
        salutation: user?.salutation,

    };

    const token = jwt.sign(
        { payload: data },
        {
            key: privateKey.replace(/\\n/gm, '\n'),
            passphrase: TokenSecret,
        },
        {
            issuer: TokenIssuer,
            algorithm: 'RS512',
            expiresIn: '1d',
        }
    );
    return token;
};
// Platform staff (ProviderUser model) ONLY. Never carries a company claim —
// verifyProviderToken rejects any token that has one.
const generateProviderUserToken = (user) => {
    const data = {
        id: user._id,
        email: user.email,
        fullName: user.fullName,
        username: user.username,
        role: user.role,
        phone: user.phone,
        department: user.department,
        position: user.position,
        accountType: 'ProviderUser',
    };
    const token = jwt.sign(
        { payload: data },
        {
            key: privateKey.replace(/\\n/gm, '\n'),
            passphrase: TokenSecret,
        },
        {
            issuer: TokenIssuer,
            algorithm: 'RS512',
            expiresIn: '1d',
        }
    );
    return token;
};

// Insurer-portal admins (Users model). Distinct accountType so provider-only
// middleware can tell an insurer admin from AVE platform staff, and always
// carries the tenant (`company`) claim used to scope every query.
const generateCompanyUserToken = (user) => {
    const data = {
        id: user._id,
        email: user.email,
        fullName: user.fullName,
        username: user.username,
        // Login now populates role — keep the claim an id either way.
        role: user.role?._id || user.role,
        company: user.company?._id || user.company,
        phone: user.phone,
        department: user.department,
        position: user.position,
        accountType: 'CompanyUser',
    };
    const token = jwt.sign(
        { payload: data },
        {
            key: privateKey.replace(/\\n/gm, '\n'),
            passphrase: TokenSecret,
        },
        {
            issuer: TokenIssuer,
            algorithm: 'RS512',
            expiresIn: '1d',
        }
    );
    return token;
};

// Short-lived token issued after a correct password when MFA is enabled.
// It only authorizes the second step (submitting a TOTP code) — never API access.
const generateMfaChallengeToken = (userId, accountType) => {
    const data = { id: userId, accountType, purpose: 'mfa' };
    return jwt.sign(
        { payload: data },
        {
            key: privateKey.replace(/\\n/gm, '\n'),
            passphrase: TokenSecret,
        },
        {
            issuer: TokenIssuer,
            algorithm: 'RS512',
            expiresIn: '5m',
        }
    );
};

// Short-lived single-purpose token minted after a correct activation OTP
// (contract §2.2). Only authorizes POST /customers/activate — never API access.
// Carries the consumed otpCode _id so activation can enforce single use by
// atomically deleting that document, plus the delivery channel so activation
// knows whether to flip emailVerified.
const generateActivationToken = (customerId, otpCodeId, channel) => {
    const data = { id: customerId, otp: otpCodeId, channel, purpose: 'activation' };
    return jwt.sign(
        { payload: data },
        {
            key: privateKey.replace(/\\n/gm, '\n'),
            passphrase: TokenSecret,
        },
        {
            issuer: TokenIssuer,
            algorithm: 'RS512',
            expiresIn: '10m',
        }
    );
};

module.exports = { GenerateToken, generate, generatePocToken, generateProviderUserToken, generateCompanyUserToken, generateMfaChallengeToken, generateActivationToken };
