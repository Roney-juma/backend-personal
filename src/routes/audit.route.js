const verifyToken = require("../middlewheres/verifyToken");
const auditController = require("../controllers/audit.controller");
const express = require("express")

const router = express.Router();

router.get('/audit-logs', auditController.logAudit)

module.exports = router;