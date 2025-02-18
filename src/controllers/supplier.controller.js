const supplierService = require('../service/supplier.service');
const tokenService = require("../service/token.service");
const emailService = require("../service/email.service");
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
        console.error('Error creating Supplier:', err);
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
        const suppliers = await supplierService.getAllSuppliers();
        res.status(200).json(suppliers);
    } catch (err) {
        console.error('Error fetching suppliers:', err);
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
        console.error('Error fetching supplier:', err);
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
        console.error('Error updating supplier:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

const deleteSupplier = async (req, res) => {
    try {
        await supplierService.deleteSupplier(req.params.id);
        res.status(200).json({ message: 'Supplier deleted successfully' });
    } catch (err) {
        console.error('Error deleting supplier:', err);
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

      // Call the service to submit the bid
      const result = await supplierService.submitBidForSupply(claimId, supplierId, parts);

      // Handle duplicate bid case
      if (result && result.error) {
          return res.status(400).json({ message: result.error });
      }

      // If successful, return the submitted bid
      res.status(201).json({ message: 'Supply bid submitted successfully', supplyBid: result });
  } catch (err) {
      console.error('Error submitting supply bid:', err);
      res.status(500).json({ message: 'Supply bid not submitted' });
  }
};

const getAllClaimsInGarage = async (req, res) => {
    try {
        const claims = await supplierService.getClaimsInGarage();
        res.json(claims);
    } catch (err) {
        console.error('Error fetching claims:', err);
        res.status(500).json({ message: 'Failed to fetch claims' });
    }
};

const repairPartsDelivered = async (req, res) => {
    try {
        const claim = await supplierService.repairPartsDelivered(req.params.claimId);
        res.json(claim);
    } catch (err) {
        console.error('Error delivering repair parts:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

const requestPasswordReset = async (email) => {
    // Check if user exists
    const user = await supplierService.findByEmail(email);
    if (!user) {
        throw new Error('User with this email does not exist');
    }

    // Generate a token (valid for 1 hour)
    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = await bcrypt.hash(resetToken, 10);
    
    // Save hashed token and expiration date to the user in the database
    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = Date.now() + 3600000; // 1 hour from now
    await user.save();

    // Send reset link to the user's email
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
    resetPassword
};
