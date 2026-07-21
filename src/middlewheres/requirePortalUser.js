// Restricts a route to portal accounts: insurer-portal admins ('CompanyUser')
// and AVE platform staff ('ProviderUser'). Mobile actor tokens (Customer,
// Garage, Assessor, Supplier) authenticate fine through verifyToken but must
// never reach portal management routes (/users, /roles, ...) — without this
// guard an actor token resolves to no company there and would get global scope.
//
// Mount AFTER verifyToken, e.g. router.get('/', verifyToken(), requirePortalUser, handler).
// Legacy note: insurer-admin tokens issued before the CompanyUser split are
// stamped 'ProviderUser', so they pass this guard and stay scoped via the
// requesterCompany DB fallback until they expire (1 day).
const PORTAL_ACCOUNT_TYPES = ['CompanyUser', 'ProviderUser'];

const requirePortalUser = (req, res, next) => {
    const accountType = req.user?.accountType;
    if (!PORTAL_ACCOUNT_TYPES.includes(accountType)) {
        return res.status(403).json({ message: 'Forbidden: portal access only' });
    }
    next();
};

module.exports = requirePortalUser;
