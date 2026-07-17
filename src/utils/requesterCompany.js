const userService = require('../service/users.service');

// Resolve the InsuranceCompany id the authenticated requester belongs to, if any.
// Company (provider) users are scoped to their own company; AVE platform staff have
// no company and therefore get global scope. Prefers the value carried in the JWT
// payload (generateProviderUserToken now includes `company`); falls back to a DB
// lookup for older tokens issued before that field was added.
const getRequesterCompany = async (req) => {
    const fromToken = req.user?.company;
    if (fromToken) return fromToken._id || fromToken;

    const requester = await userService.getUserById(req.user?.id);
    const company = requester?.company;
    return company?._id || company || null;
};

// Whether a record is accessible to a requester scoped to `company`. Platform staff
// (company falsy) may access anything. Handles a record company that is either a raw
// ObjectId/string or a populated document.
const belongsToCompany = (recordCompany, company) => {
    if (!company) return true;
    if (!recordCompany) return false;
    const rc = recordCompany._id || recordCompany;
    return String(rc) === String(company);
};

module.exports = { getRequesterCompany, belongsToCompany };
