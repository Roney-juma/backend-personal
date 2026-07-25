const verifyToken = require("../middlewheres/verifyToken");
const requirePortalUser = require("../middlewheres/requirePortalUser");
const auditController = require("../controllers/audit.controller");
const express = require("express")

const router = express.Router();

// Portal-only: company users see their own company's logs, platform staff see all.
router.get('/audit-logs', verifyToken(), requirePortalUser, auditController.logAudit)

module.exports = router;
