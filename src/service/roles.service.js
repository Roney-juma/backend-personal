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

// Tenant read scope: a company user sees global roles (company: null) plus their
// own company's roles; platform staff (company falsy) see everything.
const readScope = (company) =>
    company ? { $or: [{ company: null }, { company }] } : {};

// Tenant write scope: a company user may only mutate roles owned by their own
// company — global roles (like Super Admin) are staff-managed only.
const writeScope = (company) => (company ? { company } : {});

// Idempotently ensure the (global) super-admin role exists and return it. Replaces
// the previously hardcoded (and unseeded) role ObjectId used at company creation.
const ensureSuperAdminRole = async () => {
    return role.findOneAndUpdate(
        { name: SUPER_ADMIN_ROLE_NAME, company: null },
        { $setOnInsert: { name: SUPER_ADMIN_ROLE_NAME, company: null, permissions: allPermissions() } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
};

const createRole = async (roleData, company) => {
    try {
        // A company user's roles always belong to their own company, regardless of
        // what the client sends; staff may create global or any-company roles.
        const data = { ...roleData };
        if (company) data.company = company;
        const newRole = new role(data);
        await newRole.save();
        return newRole;
    } catch (error) {
        logger.error('Error creating role:', error);
        throw error;
    }
};

const getAllRoles = async (company) => {
    try {
        return await role.find(readScope(company));
    } catch (error) {
        logger.error('Error fetching roles:', error);
        throw error;
    }
};

const getRoleById = async (roleId, company) => {
    try {
        const roleData = await role.findOne({ _id: roleId, ...readScope(company) });
        if (!roleData) {
            throw new Error('Role not found');
        }
        return roleData;
    } catch (error) {
        logger.error('Error fetching role:', error);
        throw error;
    }
};

const updateRole = async (roleId, roleData, company) => {
    try {
        // Strip company from the payload so a role can't be moved between tenants
        // or turned global by a company user.
        const data = { ...roleData };
        if (company) delete data.company;
        const updatedRole = await role.findOneAndUpdate(
            { _id: roleId, ...writeScope(company) },
            data,
            { new: true }
        );
        if (!updatedRole) {
            throw new Error('Role not found');
        }
        return updatedRole;
    } catch (error) {
        logger.error('Error updating role:', error);
        throw error;
    }
};

const deleteRole = async (roleId, company) => {
    try {
        const deletedRole = await role.softDeleteOne({ _id: roleId, ...writeScope(company) });
        if (!deletedRole) {
            throw new Error('Role not found');
        }
        return deletedRole;
    } catch (error) {
        logger.error('Error deleting role:', error);
        throw error;
    }
};

const getRoleByName = async (roleName, company) => {
    try {
        // Prefer the tenant's own role over a same-named global one.
        const roles = await role.find({ name: roleName, ...readScope(company) });
        const roleData = roles.find(r => r.company) || roles[0];
        if (!roleData) {
            throw new Error('Role not found');
        }
        return roleData;
    } catch (error) {
        logger.error('Error fetching role:', error);
        throw error;
    }
};

const getRolesByIds = async (roleIds, company) => {
    try {
        return await role.find({ _id: { $in: roleIds.map(id => ObjectId(id)) }, ...readScope(company) });
    } catch (error) {
        logger.error('Error fetching roles:', error);
        throw error;
    }
};

const getRolesByUserId = async (userId, company) => {
    try {
        return await role.find({ users: userId, ...readScope(company) });
    } catch (error) {
        logger.error('Error fetching roles:', error);
        throw error;
    }
};

const getRolesByPermission = async (permission, company) => {
    try {
        return await role.find({ permissions: permission, ...readScope(company) });
    } catch (error) {
        logger.error('Error fetching roles:', error);
        throw error;
    }
};

// Create Bulk Roles (staff seeding, or a company seeding its own set)
const createBulkRoles = async (rolesData, company) => {
    try {
        const bulkOps = rolesData.map(r => {
            const data = { ...r, ...(company ? { company } : { company: r.company ?? null }) };
            return {
                updateOne: {
                    filter: { name: data.name, company: data.company },
                    update: { $setOnInsert: data },
                    upsert: true,
                },
            };
        });
        return await role.bulkWrite(bulkOps);
    } catch (error) {
        logger.error('Error creating bulk roles:', error);
        throw error;
    }
};

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
