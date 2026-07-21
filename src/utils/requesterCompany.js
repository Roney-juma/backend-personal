const userService = require('../service/users.service');

// Resolve the InsuranceCompany id the authenticated requester belongs to, if any.
// Insurer-portal admins (accountType 'CompanyUser') and mobile actors (Customer/
// Garage/Assessor/Supplier) carry the tenant in the JWT `company` claim; AVE
// platform staff (accountType 'ProviderUser') have no company and get global
// scope. The DB fallback covers legacy insurer-admin tokens that were stamped
// ProviderUser without a company claim (issued before the CompanyUser split) —
// for genuine staff the lookup misses the Users collection and yields null.
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
