const multer = require('multer');
const multerS3 = require('multer-s3');
const AWS = require('aws-sdk');
const path = require('path');
require("dotenv").config();

// Set up AWS S3 configuration
const imageUpload = async (req, res) => {
    try {
        AWS.config.update({
            accessKeyId: process.env.SECRET_ID_AWS,
            secretAccessKey: process.env.SECRET_KEY_AWS,
            region: process.env.AWS_REGION,
        });

        const s3 = new AWS.S3({ httpOptions: { timeout: 60000000 } });

        const files = req.files;
        // If file not array, convert to array
        if (!Array.isArray(files)) {
            files = [files];
            }
        if (!files || files.length === 0) {
            return res.status(400).json({ message: 'No files uploaded' });
        }

        const uploadPromises = files.map(file => {
            const params = {
                Bucket: process.env.BUCKET_NAME,
                Key: `aveinsuranceclaims/image_${Date.now()}_${file.originalname}`,
                Body: file.buffer,
                // ACL: 'public-read',
                ContentType: file.mimetype,
            };

            return s3.upload(params).promise();
        });

        const results = await Promise.all(uploadPromises);

        const uploadedUrls = results.map(result => result.Location);

        return res.status(201).json({ message: 'Files uploaded successfully', urls: uploadedUrls });
    } catch (error) {
        console.error('Server error: ', error);
        return res.status(500).json({ message: 'Server side error' });
    }
};

module.exports = { imageUpload };
