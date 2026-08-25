const express = require('express');
const router = express.Router();
const controller = require('../controllers/task.controller');
const verifyProviderToken = require('../middlewheres/verifyProviderToken');

router.use(verifyProviderToken());

router.get('/summary', controller.getSummary);
router.get('/options', controller.getOptions);

router.get('/',    controller.getAllTasks);
router.post('/',   controller.createTask);
router.get('/:id', controller.getTaskById);
router.patch('/:id', controller.updateTask);
router.post('/:id/comments', controller.commentOnTask);
router.delete('/:id', controller.deleteTask);

module.exports = router;
