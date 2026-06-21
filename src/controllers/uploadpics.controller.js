const AWS = require('aws-sdk');
const logger = require('../middlewheres/logger');
require("dotenv").config();

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
            ContentType: file.mimetype,
        };

        s3.upload(params, (err, data) => {
            if (err) {
                logger.error('Error uploading file to S3: %s', err.message);
                return res.status(500).json({ message: 'Error uploading file to S3', error: err });
            }
            if (data) {
                return res.status(201).json({ message: 'File uploaded successfully', url: data.Location });
            }
        });
    } catch (error) {
        logger.error('Server error during image upload: %s', error.message);
        return res.status(500).json({ message: 'Server side error', error: error });
    }
};

module.exports = { imageUpload };
