const bcrypt = require('bcrypt');
const InsuranceCompany = require('../models/insuranceCompany.model');
const emailService = require('./email.service');
const userService = require('./users.service');
const rolesService = require('./roles.service');

const createCompany = async (data) => {
  const { companyName, registrationNumber, email, password, phone, address, contactPerson, website, notes } = data;

  const existing = await InsuranceCompany.findOne({ $or: [{ email }, { registrationNumber }] });
  if (existing) {
    throw new Error('A company with this email or registration number already exists');
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const company = new InsuranceCompany({
    companyName,
    registrationNumber,
    email,
    password: hashedPassword,
    phone,
    address,
    contactPerson,
    website,
    notes,
    status: 'pending',
  });

  const saved = await company.save();

  // The contact person becomes the company's first (super-admin) user and can log
  // into the insurer portal to manage the rest of their company's users.
  const superAdminRole = await rolesService.ensureSuperAdminRole();
  contactPerson.password = password;
  contactPerson.role = superAdminRole._id;
  contactPerson.company = saved._id;
  const insuranceUser = await userService.createUser(contactPerson);



  await emailService.sendEmailNotification(
    saved.email,
    'Welcome — Your Company Account Has Been Created',
    `Dear ${saved.companyName},\n\nYour account has been created on our platform.\nEmail: ${saved.email}\n\nPlease await activation from our team.\n\nRegards,\nPlatform Team`
  );

  return saved;
};

const getAllCompanies = async ({ status, search, page = 1, limit = 20 } = {}) => {
  const filter = {};
  if (status) filter.status = status;
  if (search) {
    filter.$or = [
      { companyName: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
      { registrationNumber: { $regex: search, $options: 'i' } },
    ];
  }
  const skip = (page - 1) * limit;
  const [companies, total] = await Promise.all([
    InsuranceCompany.find(filter).select('-password').sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
    InsuranceCompany.countDocuments(filter),
  ]);
  return { companies, total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) };
};

// Get company Users
const getCompanyUsers = async (companyId, options = {}) => {
  return userService.getUsersByCompanyId(companyId, options);
};

// Get the garages/assessors/suppliers that belong to a company. Reuses each
// domain service's list function (lazy require to avoid load-order cycles) and
// normalizes to a consistent { <items>, total, page, limit, pages } shape.
const getCompanyGarages = async (companyId, { page = 1, limit = 100, search = '' } = {}) => {
  const garageService = require('./garage.service');
  const result = await garageService.getAllGarages({ company: companyId }, page, limit);
  return {
    garages: result.garages || [],
    total: result.totalGarages || 0,
    page: Number(page),
    limit: Number(limit),
    pages: result.totalPages || 0,
  };
};

const getCompanyAssessors = async (companyId, { page = 1, limit = 100, search = '' } = {}) => {
  const assessorService = require('./assessor.service');
  return assessorService.getAssessors({ page, limit, search, company: companyId });
};

const getCompanySuppliers = async (companyId, { page = 1, limit = 100, search = '' } = {}) => {
  const supplierService = require('./supplier.service');
  return supplierService.getAllSuppliers({ page, limit, search, insuranceCompany: companyId });
};

// Public directory for the mobile app's company picker — active companies only,
// and only the fields safe to expose without auth (no emails/phones).
const getPublicCompanies = async () => {
  return InsuranceCompany.find({ status: 'active' })
    .select('_id companyName logo')
    .sort({ companyName: 1 })
    .lean();
};

const getCompanyById = async (id) => {
  return InsuranceCompany.findById(id).select('-password');
};

const updateCompany = async (id, data) => {
  if (data.password) {
    data.password = await bcrypt.hash(data.password, 10);
  }
  return InsuranceCompany.findByIdAndUpdate(id, data, { new: true }).select('-password');
};

const updateCompanyStatus = async (id, status) => {
  const update = { status };
  if (status === 'active') update.onboardedAt = new Date();
  return InsuranceCompany.findByIdAndUpdate(id, update, { new: true }).select('-password');
};

const deleteCompany = async (id) => {
  return InsuranceCompany.softDeleteById(id);
};

const loginCompany = async (email, password) => {
  const company = await InsuranceCompany.findOne({ email });
  if (!company) return null;

  const match = await bcrypt.compare(password, company.password);
  if (!match) return null;

  if (company.status === 'suspended') {
    throw new Error('Account suspended. Please contact support.');
  }

  company.lastActiveAt = new Date();
  await company.save();

  return company;
};

const resetCompanyPassword = async (email, newPassword) => {
  const company = await InsuranceCompany.findOne({ email });
  if (!company) throw new Error('Company not found');
  company.password = await bcrypt.hash(newPassword, 10);
  await company.save();
  return { message: 'Password reset successfully' };
};

const getCompanyStats = async (id) => {
  const CompanySubscription = require('../models/companySubscription.model');
  const Invoice = require('../models/invoice.model');
  const ApiKey = require('../models/apiKey.model');
  const SupportTicket = require('../models/supportTicket.model');

  const [subscription, invoices, apiKeys, tickets] = await Promise.all([
    CompanySubscription.findOne({ company: id, status: 'active' }).populate('plan'),
    Invoice.find({ company: id }),
    ApiKey.find({ company: id, status: 'active' }),
    SupportTicket.find({ company: id }),
  ]);

  const totalBilled = invoices.reduce((sum, inv) => sum + inv.total, 0);
  const totalPaid = invoices.filter(i => i.status === 'paid').reduce((sum, inv) => sum + inv.total, 0);

  return {
    activeSubscription: subscription,
    billing: {
      totalInvoices: invoices.length,
      totalBilled,
      totalPaid,
      outstanding: totalBilled - totalPaid,
    },
    activeApiKeys: apiKeys.length,
    support: {
      total: tickets.length,
      open: tickets.filter(t => t.status === 'open').length,
      resolved: tickets.filter(t => t.status === 'resolved').length,
    },
  };
};

module.exports = {
  createCompany,
  getAllCompanies,
  getPublicCompanies,
  getCompanyById,
  updateCompany,
  updateCompanyStatus,
  deleteCompany,
  loginCompany,
  resetCompanyPassword,
  getCompanyStats,
  getCompanyUsers,
  getCompanyGarages,
  getCompanyAssessors,
  getCompanySuppliers
};
