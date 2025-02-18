const Customer = require("../models/customerModel.js");
const Garage = require('../models/garage.model');
const Assessor = require('../models/assessor.model.js');
const Claim = require('../models/claim.model');
const bcrypt = require('bcrypt')
const ApiError = require('../utils/ApiError.js');
const emailService = require("../service/email.service");
const tokenService = require("../service/token.service");

async function createCustomer(cus) {
  const existingGarage = await Garage.findOne({ email: cus.email });
  const existingCustomer = await Customer.findOne({ email: cus.email });
  const existingAssessor = await Assessor.findOne({ email: cus.email });
  if (existingGarage || existingCustomer || existingAssessor) {
    throw new Error('We already have this Email in the System');
  }

  if (existingCustomer) {
    throw new Error('Customer already exists');
  }

  const password = await bcrypt.hash(cus.password, 10);
  cus.password = password;

  // Create new customer
  return await Customer.create(cus);
}
const loginUser = async (email, password) => {
  const user = await Customer.findOne({ email });
  if (!user || !(await user.isPasswordMatch(password))) {
    throw new Error("Invalid email or password");
  }
  const tokens = tokenService.GenerateToken(user);
  return { user, tokens };
};

const getCustomers = async () => {
  return await Customer.find();
};

const getCustomerClaims = async (customerId) => {
  const customer = await Customer.findById(customerId);
  if (!customer) {
    throw new Error('Customer not found');
  }

  const claims = await Claim.find({ 'claimant.email': customer.email });
  if (claims.length === 0) {
    throw new Error('No claims found for this customer');
  }

  return claims;
};
const sendWelcomeEmail = async (customer) => {
  const subject = 'Welcome to Ave Insurance - Your New Account Details';
  const message = `
    Dear ${customer.firstName} ${customer.lastName},

    We are delighted to welcome you to Ave Insurance! Your new account has been successfully created.

    Here are your account details:
    - Name: ${customer.firstName} ${customer.lastName}
    - Email: ${customer.email}
    - Phone: ${customer.phone}

    You can log in to your account using your registered email address. Please feel free to reach out to our support team if you have any questions or need further assistance.

    Thank you for choosing Ave Insurance.

    Best Regards,
    Admin Team
  `;

  await emailService.sendEmailNotification(customer.email, subject, message);
};

const resetPassword = async (email, newPassword) => {
  const user = await Customer.findOne({ email });
  if (!user) {
    throw new Error('Invalid request');
  }

  // const isTokenValid = await bcrypt.compare(token, user.resetPasswordToken);
  // if (!isTokenValid || user.resetPasswordExpires < Date.now()) {
  //     throw new Error('Token is invalid or expired');
  // }

  const hashedPassword = await bcrypt.hash(newPassword, 10);
  user.password = hashedPassword;

  // Clear reset token and expiration
  user.resetPasswordToken = undefined;
  user.resetPasswordExpires = undefined;

  await user.save();

  return { message: 'Password has been reset successfully' };
};

// update customer
const updateCustomer = async (customerId, customer) => {
  return await Customer.findByIdAndUpdate
    (customerId, customer, { new: true });
};

const getCustomerStats = async () => {
  const customersCount = await Customer.countDocuments();
  const newCustomersCount = await Customer.countDocuments({
    createdAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) }
  });
  const recurringCustomersCount = customersCount - newCustomersCount;
  return { customersCount, newCustomersCount, recurringCustomersCount };
  };

// Find garages closer to my claim location
const findGarages = async (claimId) => {
  console.log("Here we go");
  const claim = await Claim.findById(claimId);
  if (!claim) {
    throw new Error('Invalid request: Claim not found');
  }

  // Extract incident location
  const { longitude: incidentLongitude, latitude: incidentLatitude } = claim.incidentDetails;

  // Find all garages
  const garages = await Garage.find({});

  // Filter garages within a 20 km radius
  const nearbyGarages = garages.filter((garage) => {
    const distance = getDistanceFromLatLonInKm(
      incidentLatitude,
      incidentLongitude,
      garage.location.latitude,
      garage.location.longitude
    );
    return distance <= 30;
  });

  return nearbyGarages;
};

// Helper function to calculate distance between two points using the Haversine formula
const getDistanceFromLatLonInKm = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Radius of the Earth in kilometers
  const dLat = degToRad(lat2 - lat1);
  const dLon = degToRad(lon2 - lon1);
  console.log("Here we are",lat1, lon1, lat2, lon2);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(degToRad(lat1)) *
      Math.cos(degToRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c; // Distance in kilometers
  console.log("Destination", distance);

  return distance;
};

// Helper function to convert degrees to radians
const degToRad = (deg) => (deg * Math.PI) / 180;

module.exports = {
  createCustomer,
  loginUser,
  getCustomers,
  getCustomerClaims,
  sendWelcomeEmail,
  resetPassword,
  updateCustomer,
  getCustomerStats,
  findGarages
};

