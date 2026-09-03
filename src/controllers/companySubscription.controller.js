const companySubscriptionService = require('../service/companySubscription.service');

const createSubscription = async (req, res) => {
  try {
    const subscription = await companySubscriptionService.createSubscription(req.body);
    res.status(201).json(subscription);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const getAllSubscriptions = async (req, res) => {
  try {
    const result = await companySubscriptionService.getAllSubscriptions(req.query);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getSubscriptionById = async (req, res) => {
  try {
    const subscription = await companySubscriptionService.getSubscriptionById(req.params.id);
    if (!subscription) return res.status(404).json({ message: 'Subscription not found' });
    res.status(200).json(subscription);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getSubscriptionsByCompany = async (req, res) => {
  try {
    const subscriptions = await companySubscriptionService.getSubscriptionsByCompany(req.params.companyId);
    res.status(200).json(subscriptions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateSubscription = async (req, res) => {
  try {
    const subscription = await companySubscriptionService.updateSubscription(req.params.id, req.body);
    if (!subscription) return res.status(404).json({ message: 'Subscription not found' });
    res.status(200).json(subscription);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const cancelSubscription = async (req, res) => {
  try {
    const { reason } = req.body;
    const subscription = await companySubscriptionService.cancelSubscription(req.params.id, reason);
    if (!subscription) return res.status(404).json({ message: 'Subscription not found' });
    res.status(200).json(subscription);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const renewSubscription = async (req, res) => {
  try {
    const subscription = await companySubscriptionService.renewSubscription(req.params.id);
    res.status(200).json(subscription);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

/**
 * Raise the invoice for this subscription's current period.
 *
 * Shares invoiceForPeriod with the nightly renewal sweep, so a subscription
 * billed by hand and one billed by the clock produce the same document — and
 * the same period cannot be billed twice by using both.
 */
const invoiceSubscription = async (req, res) => {
  try {
    const billing = require('../service/billingLifecycle.service');
    const invoice = await billing.invoiceForPeriod(req.params.id);
    if (!invoice) {
      return res.status(409).json({ message: 'This period has already been invoiced.' });
    }
    res.status(201).json(invoice);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

module.exports = {
  createSubscription,
  getAllSubscriptions,
  getSubscriptionById,
  getSubscriptionsByCompany,
  updateSubscription,
  cancelSubscription,
  renewSubscription,
  invoiceSubscription,
};
