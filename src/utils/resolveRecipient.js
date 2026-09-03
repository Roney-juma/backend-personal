const Customer = require('../models/customerModel');
const Assessor = require('../models/assessor.model');
const Garage = require('../models/garage.model');
const Supplier = require('../models/supplier.model');
const Investigator = require('../models/investigator.model');
const InsuranceCompany = require('../models/insuranceCompany.model');
const Users = require('../models/users.model');
const Advocate = require('../models/advocate.model');
const ProviderUser = require('../models/providerUser.model');

/**
 * Resolve a notification recipient (by email) to:
 *   - phone: their number, for mirroring the email to WhatsApp
 *   - companyName: the insurer/tenant they belong to, for white-labelling the
 *     message so it says the actual insurance company's name (this is a SaaS
 *     product) instead of a hardcoded platform brand.
 * Best-effort — any piece that can't be resolved comes back null, and the email
 * still sends unchanged.
 */
const resolveRecipient = async (email) => {
  const e = String(email || '').trim();
  if (!e) return { phone: null, companyName: null };

  const safe = (p) => p.catch(() => null);
  // `staff` and `adv` were added with the Legal module: before that, every
  // notification recipient was a customer or an external service vendor, so
  // insurer STAFF and panel ADVOCATES resolved to nothing — meaning their emails
  // sent unbranded and were never mirrored to WhatsApp. Legal reminders go
  // mostly to staff, so without these two the module's most important messages
  // would be the least well delivered.
  // `prov` is AVE's own staff in the provider portal. Everything the internal
  // workspace sends — meeting invitations, reschedules, task assignments — goes
  // to these addresses, so without this lookup the module whose recipients are
  // all internal was the one module that never reached WhatsApp.
  const [cust, asr, gar, sup, inv, co, staff, adv, prov] = await Promise.all([
    safe(Customer.findOne({ email: e }).select('phone company').lean()),
    safe(Assessor.findOne({ email: e }).select('contactInfo company').lean()),
    safe(Garage.findOne({ email: e }).select('contactNumber company').lean()),
    safe(Supplier.findOne({ email: e }).select('phone insuranceCompany').lean()),
    safe(Investigator.findOne({ email: e }).select('contactNumber company').lean()),
    safe(InsuranceCompany.findOne({ email: e }).select('companyName phone').lean()),
    safe(Users.findOne({ email: e }).select('phone company').lean()),
    safe(Advocate.findOne({ email: e }).select('phone company').lean()),
    safe(ProviderUser.findOne({ email: e }).select('phone').lean()),
  ]);

  const phone =
    cust?.phone || asr?.contactInfo?.phone || gar?.contactNumber ||
    sup?.phone || inv?.contactNumber || co?.phone ||
    staff?.phone || adv?.phone || prov?.phone || null;

  // The recipient may BE an insurance company; otherwise resolve their tenant.
  // Provider staff are deliberately absent below: they work for the platform,
  // not for an insurer, so their mail must not be white-labelled to one.
  let companyName = co?.companyName || null;
  if (!companyName) {
    const companyId =
      cust?.company || asr?.company || gar?.company || sup?.insuranceCompany ||
      inv?.company || staff?.company || adv?.company || null;
    if (companyId) {
      const c = await safe(InsuranceCompany.findById(companyId).select('companyName').lean());
      companyName = c?.companyName || null;
    }
  }

  return { phone, companyName };
};

module.exports = resolveRecipient;
