const express = require("express");
const imagesController = require("../controllers/uploadpics.controller")
const Upload = require('../utils/upload')
const router = express.Router();


router.post('/upload', Upload.single('image'), imagesController.imageUpload);

// Report documents (PDF/Word) — assessor assessment reports and similar.
router.post('/upload-document', Upload.single('document'), imagesController.documentUpload);


module.exports = router;