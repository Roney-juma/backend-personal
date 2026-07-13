const supplierService = require('../service/supplier.service');
const tokenService = require("../service/token.service");
const emailService = require("../service/email.service");
const logger = require('../middlewheres/logger');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const createSupplier = async (req, res) => {
    try {
        const supplier = await supplierService.createSupplier(req.body);

        if (supplier && supplier.email) {
            emailService.sendEmailNotification(
                supplier.email,
                'Welcome To Ave Insurance',
                `Dear ${supplier.name},

                You have successfully been registered to Ave Insurance as a Supplier.

                Your login credentials are as follows:
                Username: ${supplier.email}
                Password: ${req.body.password}

                Please keep this information secure.

                Best Regards,
                Admin Team`
            );
        }

        res.status(201).json(supplier);
    } catch (err) {
        if (err.statusCode === 'Email is already registered') {
            return res.status(400).json({ error: 'Email is already registered' });
        }
        logger.error('Error creating supplier: %s', err.message);
        res.status(500).json({ error: 'Server error' });
    }
};

const login = async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await supplierService.loginUserWithEmailAndPassword(email, password);
        if (!user) {
            return res.status(401).json({ message: "Invalid email or password" });
        }
        if (user.mfaEnabled) {
            const mfaToken = tokenService.generateMfaChallengeToken(user._id, 'Supplier');
            return res.status(200).json({ mfaRequired: true, mfaToken });
        }
        const tokens = tokenService.GenerateToken(user);
        res.send({ user, tokens });
    } catch (err) {
        if (err.code === 'ACCOUNT_LOCKED') {
            return res.status(429).json({ error: err.message });
        }
        res.status(500).json({ error: 'Login failed' });
    }
};

const getAllSuppliers = async (req, res) => {
    try {
        const { page, limit, search } = req.query;
        const suppliers = await supplierService.getAllSuppliers({ page, limit, search });
        res.status(200).json(suppliers);
    } catch (err) {
        logger.error('Error fetching suppliers: %s', err.message);
        res.status(500).json({ error: 'Server error' });
    }
};

const getSupplierById = async (req, res) => {
    try {
        const supplier = await supplierService.getSupplierById(req.params.id);
        if (!supplier) {
            return res.status(404).json({ error: 'Supplier not found' });
        }
        res.status(200).json(supplier);
    } catch (err) {
        logger.error('Error fetching supplier: %s', err.message);
        res.status(500).json({ error: 'Server error' });
    }
};

const updateSupplier = async (req, res) => {
    try {
        const supplier = await supplierService.updateSupplier(req.params.id, req.body);
        if (!supplier) {
            return res.status(404).json({ error: 'Supplier not found' });
        }
        res.status(200).json(supplier);
    } catch (err) {
        logger.error('Error updating supplier: %s', err.message);
        res.status(500).json({ error: 'Server error' });
    }
};

const deleteSupplier = async (req, res) => {
    try {
        await supplierService.deleteSupplier(req.params.id);
        res.status(200).json({ message: 'Supplier deleted successfully' });
    } catch (err) {
        logger.error('Error deleting supplier: %s', err.message);
        res.status(500).json({ error: 'Server error' });
    }
};

const getMyBidHistory = async (req, res) => {
    try {
        const bidHistory = await supplierService.getSupplierBids(req.params.supplierId);
        res.json(bidHistory);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
};

const submitBidForSupply = async (req, res) => {
    try {
        const { claimId } = req.params;
        const { supplierId, parts } = req.body;
        logger.info('Submitting supply parts for claim %s', claimId);

        const result = await supplierService.submitBidForSupply(claimId, supplierId, parts);

        if (result && result.error) {
            return res.status(400).json({ message: result.error });
        }

        res.status(201).json({ message: 'Supply bid submitted successfully', supplyBid: result });
    } catch (err) {
        logger.error('Error submitting supply bid: %s', err.message);
        res.status(500).json({ message: 'Supply bid not submitted' });
    }
};

const getAllClaimsInGarage = async (req, res) => {
    try {
        const claims = await supplierService.getClaimsInGarage();
        console.log('Claims in garage:', claims);
        res.json(claims);
    } catch (err) {
        logger.error('Error fetching claims in garage: %s', err.message);
        res.status(500).json({ message: 'Failed to fetch claims' });
    }
};

const repairPartsDelivered = async (req, res) => {
    try {
        const claim = await supplierService.repairPartsDelivered(req.params.claimId);
        res.json(claim);
    } catch (err) {
        logger.error('Error delivering repair parts: %s', err.message);
        res.status(500).json({ error: 'Server error' });
    }
};

const forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required' });
        const response = await supplierService.forgotPassword(email);
        res.status(200).json(response);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

const resetPassword = async (req, res) => {
    try {
        const { email, token, newPassword } = req.body;
        if (!email || !token || !newPassword) {
            return res.status(400).json({ error: 'Email, token and newPassword are required' });
        }
        const response = await supplierService.resetPassword(email, token, newPassword);
        res.status(200).json(response);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

const updateFcmToken = async (req, res) => {
    try {
        const { fcmToken } = req.body;
        if (!fcmToken) return res.status(400).json({ message: 'fcmToken is required' });
        const { updateFcmToken: update } = require('../service/firebase.service');
        await update(req.params.id, 'supplier', fcmToken);
        res.status(200).json({ message: 'FCM token updated' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

module.exports = {
    createSupplier,
    login,
    getAllSuppliers,
    getSupplierById,
    updateSupplier,
    deleteSupplier,
    getMyBidHistory,
    submitBidForSupply,
    getAllClaimsInGarage,
    repairPartsDelivered,
    forgotPassword,
    resetPassword,
    updateFcmToken,
};
