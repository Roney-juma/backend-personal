const Customer = require('../models/customerModel');
const Assessor = require('../models/assessor.model');
const Garage = require('../models/garage.model');
const Supplier = require('../models/supplier.model');
const Investigator = require('../models/investigator.model');
const InsuranceCompany = require('../models/insuranceCompany.model');

/**
 * Resolve a recipient's phone number from their email across every actor type,
 * so an email notification can be mirrored to WhatsApp without changing call
 * sites. Returns null if no record (or no phone) is found — the email still sends.
 * Best-effort: any lookup that errors is treated as "not found".
 */
const findPhoneByEmail = async (email) => {
  const e = String(email || '').trim();
  if (!e) return null;

  const safe = (p) => p.catch(() => null);
  const [cust, asr, gar, sup, inv, co] = await Promise.all([
    safe(Customer.findOne({ email: e }).select('phone').lean()),
    safe(Assessor.findOne({ email: e }).select('contactInfo').lean()),
    safe(Garage.findOne({ email: e }).select('contactNumber').lean()),
    safe(Supplier.findOne({ email: e }).select('phone').lean()),
    safe(Investigator.findOne({ email: e }).select('contactNumber').lean()),
    safe(InsuranceCompany.findOne({ email: e }).select('phone').lean()),
  ]);

  return (
    cust?.phone ||
    asr?.contactInfo?.phone ||
    gar?.contactNumber ||
    sup?.phone ||
    inv?.contactNumber ||
    co?.phone ||
    null
  );
};

module.exports = findPhoneByEmail;
