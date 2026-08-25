const express = require('express');
const router = express.Router();
const controller = require('../controllers/issue.controller');
const verifyProviderToken = require('../middlewheres/verifyProviderToken');

router.use(verifyProviderToken());

router.get('/summary', controller.getSummary);
router.get('/options', controller.getOptions);

router.get('/',    controller.getAllIssues);
router.post('/',   controller.createIssue);
router.get('/:id', controller.getIssueById);
router.patch('/:id', controller.updateIssue);
router.post('/:id/comments', controller.commentOnIssue);
router.delete('/:id', controller.deleteIssue);

module.exports = router;
