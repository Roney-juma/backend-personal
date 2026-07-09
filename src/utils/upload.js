const multer = require('multer');
const multerS3 = require('multer-s3');
const AWS = require('aws-sdk');
const path = require('path');
require("dotenv").config();


const s3 = new AWS.S3();
const Upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MiB (was 10 TiB — the extra *1024*1024 was a typo)
  },
});

module.exports = Upload;