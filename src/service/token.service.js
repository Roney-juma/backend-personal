const jwt = require('jsonwebtoken');
const { TokenIssuer, TokenSecret } = require('../constants/encryption.constants');
const { Encrypt } = require('../utils/encription.js');
const { readPrivateKey } = require('../config/keys');

const privateKey = readPrivateKey();

const GenerateToken = (user) => {
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

const generateCompanyToken = (company) => {
    const data = {
        id: company._id,
        companyName: company.companyName,
        email: company.email,
        status: company.status,
        registrationNumber: company.registrationNumber,
        accountType: 'InsuranceCompany',
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

module.exports = { GenerateToken, generate, generatePocToken, generateCompanyToken, generateProviderUserToken, generateMfaChallengeToken };
