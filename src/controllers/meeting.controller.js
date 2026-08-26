const service = require('../service/meeting.service');
const Meeting = require('../models/meeting.model');

const createMeeting = async (req, res) => {
  try {
    const { title, startAt, endAt } = req.body;
    if (!title || !startAt || !endAt) {
      return res.status(400).json({ message: 'title, startAt and endAt are required.' });
    }
    if (new Date(endAt) <= new Date(startAt)) {
      return res.status(400).json({ message: 'endAt must be after startAt.' });
    }
    const meeting = await service.create(req.body, req.user);
    res.status(201).json(meeting);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const getAllMeetings = async (req, res) => {
  try {
    res.status(200).json(await service.getAll(req.query));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getMeetingById = async (req, res) => {
  try {
    const result = await service.getById(req.params.id);
    if (!result) return res.status(404).json({ message: 'Meeting not found.' });
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateMeeting = async (req, res) => {
  try {
    const meeting = await service.update(req.params.id, req.body);
    if (!meeting) return res.status(404).json({ message: 'Meeting not found.' });
    res.status(200).json(meeting);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const completeMeeting = async (req, res) => {
  try {
    const meeting = await service.complete(req.params.id, req.body, req.user);
    if (!meeting) return res.status(404).json({ message: 'Meeting not found.' });
    res.status(200).json(meeting);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const deleteMeeting = async (req, res) => {
  try {
    const removed = await service.remove(req.params.id, req.query.scope);
    if (!removed) return res.status(404).json({ message: 'Meeting not found.' });
    res.status(200).json({ message: 'Meeting deleted.' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const getCalendar = async (req, res) => {
  try {
    res.status(200).json(await service.calendar(req.query));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getSummary = async (req, res) => {
  try {
    res.status(200).json(await service.summary());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Enum catalogue so the portal builds its dropdowns from the schema, not a copy.
const getOptions = (req, res) => {
  res.status(200).json({ types: Meeting.MEETING_TYPES, statuses: Meeting.MEETING_STATUSES });
};

module.exports = {
  createMeeting,
  getAllMeetings,
  getMeetingById,
  updateMeeting,
  completeMeeting,
  deleteMeeting,
  getCalendar,
  getSummary,
  getOptions,
};
