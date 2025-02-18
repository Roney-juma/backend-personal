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

        const file = req.file;
        if (!file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }
        const params = {
            Bucket: process.env.BUCKET_NAME,
            Key: `aveinsuranceclaims/image_${Date.now()}_${file.originalname}`,
            Body: file.buffer,  
            // ACL: 'public-read',
            ContentType: file.mimetype,
        };
        s3.upload(params, (err, data) => {
            if (err) {
                console.error('Error uploading file: ', err);
                return res.status(500).json({ message: 'Error uploading file to S3', error: err });
            }
            
            if (data) {
                return res.status(201).json({ message: 'File uploaded successfully', url: data.Location });
            }
        });
    } catch (error) {
        console.error('Server error: ', error);
        return res.status(500).json({ message: 'Server side error' });
    }
};

module.exports = { imageUpload };
