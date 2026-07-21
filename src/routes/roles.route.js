// Routes for roles — portal-only (insurer admins + platform staff). Previously
// these routes had no auth middleware at all; they must never be public.
const express = require('express');
const router = express.Router();
const roleController = require('../controllers/roles.controller');
const verifyToken = require('../middlewheres/verifyToken');
const requirePortalUser = require('../middlewheres/requirePortalUser');

// Create a new role (scoped to the requester's company)
router.post('/', verifyToken(), requirePortalUser, roleController.createRole);
// Get all roles (global roles + the requester's company's roles)
router.get('/', verifyToken(), requirePortalUser, roleController.getAllRoles);
// Get a role by ID
router.get('/:id', verifyToken(), requirePortalUser, roleController.getRoleById);
// Update a role (own-company roles only; global roles are staff-managed)
router.put('/:id', verifyToken(), requirePortalUser, roleController.updateRole);
// Delete a role (own-company roles only)
router.delete('/:id', verifyToken(), requirePortalUser, roleController.deleteRole);
// Get roles by permission
router.get('/permissions/:permission', verifyToken(), requirePortalUser, roleController.getRolesByPermission);
// Get roles by name
router.get('/name/:name', verifyToken(), requirePortalUser, roleController.getRoleByName);
// Get roles by user ID
router.get('/user/:userId', verifyToken(), requirePortalUser, roleController.getRolesByUserId);
// Get roles by IDs
router.get('/ids/:ids', verifyToken(), requirePortalUser, roleController.getRolesByIds);
// Create bulk roles (seeding — scoped like createRole)
router.post('/bulk', verifyToken(), requirePortalUser, roleController.createBulkRoles);

// export the router
module.exports = router;
