const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const router = express.Router();

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configure multer for Cloudinary uploads
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'aquacare_complaints',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp']
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
});

module.exports = function (db) {
  // POST /api/complaints — Submit a new complaint
  router.post('/', upload.single('image'), async (req, res) => {
    try {
      const { name, phone, description, location } = req.body;

      if (!name || !phone || !description || !location) {
        return res.status(400).json({ error: 'Name, phone, description, and location are required.' });
      }

      const complaintId = 'AQ-' + uuidv4().slice(0, 8).toUpperCase();
      const imagePath = req.file ? req.file.path : null;

      await db.execute({
        sql: `INSERT INTO complaints (complaint_id, name, phone, description, location, image_path) VALUES (?, ?, ?, ?, ?, ?)`,
        args: [complaintId, name, phone, description, location, imagePath]
      });

      res.status(201).json({
        message: 'Complaint submitted successfully!',
        complaintId
      });
    } catch (err) {
      console.error('Error creating complaint:', err);
      res.status(500).json({ error: 'Failed to submit complaint.' });
    }
  });

  // GET /api/complaints/track/:complaintId — Track a complaint by ID
  router.get('/track/:complaintId', async (req, res) => {
    try {
      const result = await db.execute({
        sql: 'SELECT * FROM complaints WHERE complaint_id = ?',
        args: [req.params.complaintId]
      });
      const complaint = result.rows[0];

      if (!complaint) {
        return res.status(404).json({ error: 'Complaint not found. Please check the Complaint ID.' });
      }

      res.json(complaint);
    } catch (err) {
      console.error('Error tracking complaint:', err);
      res.status(500).json({ error: 'Failed to track complaint.' });
    }
  });

  return router;
};
