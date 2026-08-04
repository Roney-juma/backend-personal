const crypto = require('crypto');
const InsuranceCompany = require('../models/insuranceCompany.model');
const emailService = require('./email.service');
const userService = require('./users.service');
const rolesService = require('./roles.service');

// System-generated, human-readable company registration number: AVE-<YYYY>-<6 hex>.
// Retries on the (astronomically unlikely) collision so the unique index never trips.
const generateRegistrationNumber = async () => {
  const year = new Date().getFullYear();
  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6 hex chars
    const candidate = `AVE-${year}-${suffix}`;
    const clash = await InsuranceCompany.findOne({ registrationNumber: candidate }).select('_id').lean();
    if (!clash) return candidate;
  }
  throw new Error('Could not generate a unique registration number, please retry');
};

const createCompany = async (data) => {
  // registrationNumber and password are intentionally NOT taken from the client:
  // the reg number is system-generated and the contact person's initial password
  // is auto-assigned by createUser (a temp password, emailed, forced change on first login).
  const { companyName, email, phone, address, contactPerson, website, notes } = data;

  if (!contactPerson || !contactPerson.email || !contactPerson.username || !contactPerson.fullName) {
    throw new Error('A contact person (username, full name, email) is required');
  }

  // Company name and email are unique; the reg number we generate ourselves.
  const existing = await InsuranceCompany.findOne({ $or: [{ email }, { companyName }] });
  if (existing) {
    throw new Error('A company with this name or email already exists');
  }

  const registrationNumber = await generateRegistrationNumber();

  const company = new InsuranceCompany({
    companyName,
    registrationNumber,
    email,
    phone,
    address,
    // Store the contact person WITHOUT a credential; their login lives on the User below.
    contactPerson: {
      username: contactPerson.username,
      fullName: contactPerson.fullName,
      email: contactPerson.email,
    },
    website,
    notes,
    status: 'pending',
  });

  const saved = await company.save();

  // 1) Create this tenant's first role — "Super Admin" holding every permission.
  const superAdminRole = await rolesService.ensureCompanySuperAdminRole(saved._id);

  // 2) Create the contact person as the company's first user, assigned that role.
  //    No password is passed → createUser assigns a temporary one, emails it, and
  //    forces a change on first login.
  const insuranceUser = await userService.createUser({
    company: saved._id,
    username: contactPerson.username,
    fullName: contactPerson.fullName,
    email: contactPerson.email,
    role: superAdminRole._id,
  });

  // Keep the embedded contactPerson.role in sync for display/denormalization.
  saved.contactPerson.role = superAdminRole._id;
  await saved.save();

  await emailService.sendEmailNotification(
    saved.email,
    'Welcome — Your Company Account Has Been Created',
    `Dear ${saved.companyName},\n\nYour account has been created on our platform.\nRegistration Number: ${saved.registrationNumber}\nCompany Email: ${saved.email}\n\nYour administrator (${insuranceUser.fullName}) has been emailed their login details separately.\n\nPlease await activation from our team.\n\nRegards,\nPlatform Team`
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
  // Company-level login is retired — never (re)store a company credential.
  delete data.password;
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
  getCompanyStats,
  getCompanyUsers,
  getCompanyGarages,
  getCompanyAssessors,
  getCompanySuppliers
};
