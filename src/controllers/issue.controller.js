const service = require('../service/issue.service');
const Issue = require('../models/issue.model');

const createIssue = async (req, res) => {
  try {
    if (!req.body.title) return res.status(400).json({ message: 'title is required.' });
    const issue = await service.create(req.body, req.user);
    res.status(201).json(issue);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const getAllIssues = async (req, res) => {
  try {
    res.status(200).json(await service.getAll(req.query));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getIssueById = async (req, res) => {
  try {
    const issue = await service.getById(req.params.id);
    if (!issue) return res.status(404).json({ message: 'Issue not found.' });
    res.status(200).json(issue);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateIssue = async (req, res) => {
  try {
    const issue = await service.update(req.params.id, req.body, req.user);
    if (!issue) return res.status(404).json({ message: 'Issue not found.' });
    res.status(200).json(issue);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const commentOnIssue = async (req, res) => {
  try {
    const { body } = req.body;
    if (!body || !String(body).trim()) return res.status(400).json({ message: 'body is required.' });
    const issue = await service.addComment(req.params.id, body, req.user);
    if (!issue) return res.status(404).json({ message: 'Issue not found.' });
    res.status(200).json(issue);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const deleteIssue = async (req, res) => {
  try {
    const removed = await service.remove(req.params.id);
    if (!removed) return res.status(404).json({ message: 'Issue not found.' });
    res.status(200).json({ message: 'Issue deleted.' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const getSummary = async (req, res) => {
  try {
    res.status(200).json(await service.summary());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getOptions = (req, res) => {
  res.status(200).json({
    types: Issue.ISSUE_TYPES,
    statuses: Issue.ISSUE_STATUSES,
    priorities: Issue.PRIORITIES,
    areas: Issue.AREAS,
    sources: Issue.SOURCES,
  });
};

module.exports = {
  createIssue,
  getAllIssues,
  getIssueById,
  updateIssue,
  commentOnIssue,
  deleteIssue,
  getSummary,
  getOptions,
};
