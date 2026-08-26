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

/**
 * What counts as a "document" here: reports, invoices, quotes, receipts.
 *
 * Images belong on this list. A garage invoice or a fee note usually reaches us
 * as a phone photo of a paper original, not a PDF — refusing those made vendors
 * find a scanner before they could bill, and the form already offered .jpg while
 * the server rejected it.
 *
 * HEIC is included because that is what an iPhone produces by default; leaving
 * it out rejects the single most common camera format on the exact flow this
 * matters for.
 */
const DOCUMENT_MIME_TYPES = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
];

const documentUpload = async (req, res) => {
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
        if (!DOCUMENT_MIME_TYPES.includes(file.mimetype)) {
            return res.status(400).json({
                message: 'That file type is not supported. Upload a PDF, a Word document, or a photo (JPG, PNG, WEBP or HEIC).',
            });
        }

        const params = {
            Bucket: process.env.BUCKET_NAME,
            Key: `aveinsuranceclaims/document_${Date.now()}_${file.originalname}`,
            Body: file.buffer,
            ContentType: file.mimetype,
        };

        s3.upload(params, (err, data) => {
            if (err) {
                logger.error('Error uploading document to S3: %s', err.message);
                return res.status(500).json({ message: 'Error uploading file to S3', error: err });
            }
            if (data) {
                return res.status(201).json({ message: 'File uploaded successfully', url: data.Location });
            }
        });
    } catch (error) {
        logger.error('Server error during document upload: %s', error.message);
        return res.status(500).json({ message: 'Server side error', error: error });
    }
};

module.exports = { imageUpload, documentUpload };
