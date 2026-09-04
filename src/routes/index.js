const express =require("express")

const customer = require("./customer")
const claims = require("./claim.route")
const users = require("./users.route")
const auth = require("./auth.route")
const upload = require("./imageUploads.route")
const assessors = require("./assesor")
const garages = require("./garage.route")
const suppliers = require("./supplier.route")
const rating = require("./rating.route")
const audit = require("./audit.route")
const roles = require("./roles.route")
const provider = require("./provider.route")
const companyApi = require("./companyApi.route")
const demoRequest = require("./demoRequest.route")
const companySupport = require("./companySupport.route")
const notifications = require("./notification.route")
const investigators = require("./investigator.route")
const ai = require("./ai.route")
const claimTypes = require("./claimType.route")
const policyTypes = require("./policyType.route")
const vendorInvoices = require("./vendorInvoice.route")
const sso = require("./sso.route")
const publicCompanies = require("./publicCompanies.route")
const legal = require("./legal.route")
const advocatePortal = require("./advocatePortal.route")


const router = express.Router()


router.use("/customers", customer)
router.use("/claims", claims)
router.use("/users", users)
router.use("/auth/sso", sso)
router.use("/auth", auth)
router.use("/images", upload)
router.use("/assessors", assessors)
router.use("/garages", garages)
router.use("/suppliers", suppliers)
router.use("/rating", rating)
router.use("/audit", audit)
router.use("/roles", roles)
router.use("/provider", provider)
router.use("/api/v1", companyApi)
router.use("/demo-requests", demoRequest)
router.use("/support", companySupport)
router.use("/notifications", notifications)
router.use("/investigators", investigators)
router.use("/ai", ai)
router.use("/claim-types", claimTypes)
router.use("/policy-types", policyTypes)
router.use("/vendor-invoices", vendorInvoices)
router.use("/public/companies", publicCompanies)

// Legal & Litigation. Behind a flag while the module is still being built out —
// the schemas and scheduler exist regardless, but nothing is reachable until an
// environment opts in.
if (process.env.LEGAL_MODULE_ENABLED === 'true') {
  router.use("/legal", legal)
  // The panel advocate's own surface, served to partner-fe. Separate from
  // /legal because an advocate holds no staff permissions at all.
  router.use("/advocate-portal", advocatePortal)
}


module.exports  = router