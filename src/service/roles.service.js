const role = require('../models/roles.model');
const logger = require('../middlewheres/logger');
const mongoose = require('mongoose');
const permissionsCatalog = require('../role-permissions.json');
const { ObjectId } = mongoose.Types;

// Name of the role granted to a new company's contact person (the first/super-admin
// user of that company). It normalizes to "superadmin" in the portals — which they
// treat as unrestricted — and we also populate every permission so permission-based
// checks pass regardless.
const SUPER_ADMIN_ROLE_NAME = 'Super Admin';

const allPermissions = () => Object.values(permissionsCatalog.permissions || {}).flat();

// Idempotently ensure the super-admin role exists and return it. Replaces the
// previously hardcoded (and unseeded) role ObjectId used at company creation.
const ensureSuperAdminRole = async () => {
    return role.findOneAndUpdate(
        { name: SUPER_ADMIN_ROLE_NAME },
        { $setOnInsert: { name: SUPER_ADMIN_ROLE_NAME, permissions: allPermissions() } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
};

const createRole = async (roleData) => {
    try {
        const newRole = new role(roleData);
        await newRole.save();
        return newRole;
    } catch (error) {
        logger.error('Error creating role:', error);
        throw error;
    }
    }
const getAllRoles = async () => {
    try {
        const roles = await role.find();
        return roles;
    } catch (error) {
        logger.error('Error fetching roles:', error);
        throw error;
    }
}
const getRoleById = async (roleId) => {
    try {
        const roleData = await role.findById(roleId);
        if (!roleData) {
            throw new Error('Role not found');
        }
        return roleData;
    } catch (error) {
        logger.error('Error fetching role:', error);
        throw error;
    }
}
const updateRole = async (roleId, roleData) => {
    try {
        const updatedRole = await role.findByIdAndUpdate(roleId, roleData, { new: true });
        if (!updatedRole) {
            throw new Error('Role not found');
        }
        return updatedRole;
    } catch (error) {
        logger.error('Error updating role:', error);
        throw error;
    }
}
const deleteRole = async (roleId) => {
    try {
        const deletedRole = await role.softDeleteById(roleId);
        if (!deletedRole) {
            throw new Error('Role not found');
        }
        return deletedRole;
    } catch (error) {
        logger.error('Error deleting role:', error);
        throw error;
    }
}
const getRoleByName = async (roleName) => {
    try {
        const roleData = await role.findOne({ name: roleName });
        if (!roleData) {
            throw new Error('Role not found');
        }
        return roleData;
    } catch (error) {
        logger.error('Error fetching role:', error);
        throw error;
    }
}
const getRolesByIds = async (roleIds) => {
    try {
        const roles = await role.find({ _id: { $in: roleIds.map(id => ObjectId(id)) } });
        return roles;
    } catch (error) {
        logger.error('Error fetching roles:', error);
        throw error;
    }
}
const getRolesByUserId = async (userId) => {
    try {
        const roles = await role.find({ users: userId });
        return roles;
    } catch (error) {
        logger.error('Error fetching roles:', error);
        throw error;
    }
}
const getRolesByPermission = async (permission) => {
    try {
        const roles = await role.find({ permissions: permission });
        return roles;
    } catch (error) {
        logger.error('Error fetching roles:', error);
        throw error;
    }
}
// Create Bulk Roles
const createBulkRoles = async (rolesData) => {
    try {
        const bulkOps = rolesData.map(role => ({ updateOne: { filter: { name: role.name }, update: { $setOnInsert: role }, upsert: true } }));
        const result = await role.bulkWrite(bulkOps);
        return result;
        } catch (error) {
        logger.error('Error creating bulk roles:', error);
        throw error;
    }
    }


module.exports = {
    createRole,
    getAllRoles,
    getRoleById,
    updateRole,
    deleteRole,
    getRoleByName,
    getRolesByIds,
    getRolesByUserId,
    getRolesByPermission,
    createBulkRoles,
    ensureSuperAdminRole
};