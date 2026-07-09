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
        const tokens = tokenService.GenerateToken(user);
        res.send({ user, tokens });
    } catch (err) {
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

const requestPasswordReset = async (email) => {
    const user = await supplierService.findByEmail(email);
    if (!user) {
        throw new Error('User with this email does not exist');
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = await bcrypt.hash(resetToken, 10);

    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = Date.now() + 3600000;
    await user.save();

    const resetUrl = `https://your-app.com/reset-password?token=${resetToken}&email=${email}`;
    await emailService.sendEmailNotification(
        user.email,
        'Password Reset Request',
        `Dear ${user.name},\n\nYou have requested a password reset. Click the link below to reset your password:\n${resetUrl}\n\nIf you did not request this, please ignore this email.`
    );

    return { message: 'Password reset email sent' };
};

const resetPassword = async (req, res) => {
    try {
        const { email, newPassword } = req.body;
        const response = await supplierService.resetPassword(email, newPassword);
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
    requestPasswordReset,
    resetPassword,
    updateFcmToken,
};
