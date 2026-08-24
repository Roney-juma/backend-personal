// Central registry mapping an accountType string to its Mongoose model.
// Shared by the MFA and password-change services so both work uniformly across
// every account type (portal staff + mobile users).
module.exports = {
  User: require('../models/users.model'),            // insurer portal admins
  ProviderUser: require('../models/providerUser.model'), // platform staff
  Customer: require('../models/customerModel'),      // mobile customers
  Garage: require('../models/garage.model'),         // mobile garages
  Assessor: require('../models/assessor.model'),     // mobile assessors
  Supplier: require('../models/supplier.model'),     // mobile suppliers
  Advocate: require('../models/advocate.model'),     // panel advocates (partner portal)
};
