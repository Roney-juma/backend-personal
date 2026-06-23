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


const router = express.Router()


router.use("/customers", customer)
router.use("/claims", claims)
router.use("/users", users)
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


module.exports  = router