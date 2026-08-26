const service = require('../service/task.service');
const Task = require('../models/task.model');

const createTask = async (req, res) => {
  try {
    if (!req.body.title) return res.status(400).json({ message: 'title is required.' });
    const task = await service.create(req.body, req.user);
    res.status(201).json(task);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const getAllTasks = async (req, res) => {
  try {
    res.status(200).json(await service.getAll(req.query));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getTaskById = async (req, res) => {
  try {
    const task = await service.getById(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found.' });
    res.status(200).json(task);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateTask = async (req, res) => {
  try {
    const task = await service.update(req.params.id, req.body, req.user);
    if (!task) return res.status(404).json({ message: 'Task not found.' });
    res.status(200).json(task);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const commentOnTask = async (req, res) => {
  try {
    const { body } = req.body;
    if (!body || !String(body).trim()) return res.status(400).json({ message: 'body is required.' });
    const task = await service.addComment(req.params.id, body, req.user);
    if (!task) return res.status(404).json({ message: 'Task not found.' });
    res.status(200).json(task);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const deleteTask = async (req, res) => {
  try {
    const removed = await service.remove(req.params.id);
    if (!removed) return res.status(404).json({ message: 'Task not found.' });
    res.status(200).json({ message: 'Task deleted.' });
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
    types: Task.TASK_TYPES,
    statuses: Task.TASK_STATUSES,
    priorities: Task.PRIORITIES,
    areas: Task.AREAS,
    sources: Task.SOURCES,
  });
};

module.exports = {
  createTask,
  getAllTasks,
  getTaskById,
  updateTask,
  commentOnTask,
  deleteTask,
  getSummary,
  getOptions,
};
