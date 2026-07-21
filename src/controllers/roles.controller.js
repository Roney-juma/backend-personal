const roleService = require('../service/roles.service');
const logger = require('../middlewheres/logger');
const { getRequesterCompany } = require('../utils/requesterCompany');

// Every handler resolves the requester's tenant: company users see global roles
// plus their own company's and may only mutate their own; platform staff
// (no company) have global scope.

const createRole = async (req, res) => {
    try {
        const company = await getRequesterCompany(req);
        const newRole = await roleService.createRole(req.body, company);
        res.status(201).json(newRole);
    } catch (error) {
        logger.error('Error creating role:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
}
const getAllRoles = async (req, res) => {
    try {
        const company = await getRequesterCompany(req);
        const roles = await roleService.getAllRoles(company);
        res.status(200).json(roles);
    } catch (error) {
        logger.error('Error fetching roles:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
}
const getRoleById = async (req, res) => {
    try {
        const company = await getRequesterCompany(req);
        const roleData = await roleService.getRoleById(req.params.id, company);
        res.status(200).json(roleData);
    } catch (error) {
        logger.error('Error fetching role:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
}
const updateRole = async (req, res) => {
    try {
        const company = await getRequesterCompany(req);
        const updatedRole = await roleService.updateRole(req.params.id, req.body, company);
        res.status(200).json(updatedRole);
    }
    catch (error) {
        logger.error('Error updating role:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
}
const deleteRole = async (req, res) => {
    try {
        const company = await getRequesterCompany(req);
        const deletedRole = await roleService.deleteRole(req.params.id, company);
        res.status(200).json(deletedRole);
    }
    catch (error) {
        logger.error('Error deleting role:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
}
const getRolesByPermission = async (req, res) => {
    try {
        const company = await getRequesterCompany(req);
        const roles = await roleService.getRolesByPermission(req.params.permission, company);
        res.status(200).json(roles);
    }
    catch (error) {
        logger.error('Error fetching roles by permission:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
}
const getRolesByIds = async (req, res) => {
    try {
        const company = await getRequesterCompany(req);
        const roleIds = req.params.ids.split(',').map(id => id.trim());
        const roles = await roleService.getRolesByIds(roleIds, company);
        res.status(200).json(roles);
    }
    catch (error) {
        logger.error('Error fetching roles by IDs:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
}
const getRolesByUserId = async (req, res) => {
    try {
        const company = await getRequesterCompany(req);
        const roles = await roleService.getRolesByUserId(req.params.userId, company);
        res.status(200).json(roles);
    }
    catch (error) {
        logger.error('Error fetching roles by user ID:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
}
const getRoleByName = async (req, res) => {
    try {
        const company = await getRequesterCompany(req);
        const roleData = await roleService.getRoleByName(req.params.name, company);
        res.status(200).json(roleData);
    }
    catch (error) {
        logger.error('Error fetching role by name:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
}

const createBulkRoles = async (req, res) => {
    try {
        const company = await getRequesterCompany(req);
        const createdRoles = await roleService.createBulkRoles(req.body.roles, company);
        res.status(201).json(createdRoles);
    }
    catch (error) {
        logger.error('Error creating bulk roles:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
}

module.exports = {
    createRole,
    getAllRoles,
    getRoleById,
    updateRole,
    deleteRole,
    getRolesByPermission,
    getRolesByIds,
    getRolesByUserId,
    getRoleByName,
    createBulkRoles
    };
