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
      const { name, phone, description, location, category } = req.body;

      if (!name || !phone || !description || !location) {
        return res.status(400).json({ error: 'Name, phone, description, and location are required.' });
      }

      if (!/^\d{10}$/.test(phone)) {
        return res.status(400).json({ error: 'Mobile number must be exactly 10 digits.' });
      }

      const allowedCategories = ['Pipeline Leakage', 'Overflowing Water Tank', 'Damaged Public Tap', 'Other'];
      const complaintCategory = category || 'Other';

      if (!allowedCategories.includes(complaintCategory)) {
        return res.status(400).json({ error: 'Invalid category selected.' });
      }

      const complaintId = 'AQ-' + uuidv4().slice(0, 8).toUpperCase();
      const imagePath = req.file ? req.file.path : null;

      await db.execute({
        sql: `INSERT INTO complaints (complaint_id, name, phone, description, location, image_path, category) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [complaintId, name, phone, description, location, imagePath, complaintCategory]
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
        sql: `
          SELECT c.id, c.complaint_id, c.name, c.description, c.location, c.image_path, c.category, c.status, c.created_at, c.deadline,
                 t.name as team_name
          FROM complaints c
          LEFT JOIN teams t ON c.team_id = t.id
          WHERE c.complaint_id = ?
        `,
        args: [req.params.complaintId]
      });
      const complaint = result.rows[0];

      if (!complaint) {
        return res.status(404).json({ error: 'Complaint not found. Please check the Complaint ID.' });
      }

      // Calculate overdue
      const isOverdue = complaint.deadline && new Date(complaint.deadline) < new Date() && complaint.status !== 'Resolved';
      complaint.isOverdue = !!isOverdue;

      // Get assigned workers
      const workersRes = await db.execute({
        sql: `
          SELECT w.name 
          FROM complaint_workers cw
          JOIN workers w ON cw.worker_id = w.id
          WHERE cw.complaint_id = ?
        `,
        args: [complaint.id]
      });
      complaint.assigned_workers = workersRes.rows.map(w => w.name);

      // Get chronological status history
      // Note: Omit internal admin notes if they exist, but status_history 'notes' are just transition logs
      const historyRes = await db.execute({
        sql: `SELECT status, notes, created_at FROM status_history WHERE complaint_id = ? ORDER BY created_at ASC`,
        args: [complaint.id]
      });
      complaint.status_history = historyRes.rows;

      // Get approved completion report evidence
      const reportRes = await db.execute({
        sql: `SELECT notes, image_path, created_at FROM work_reports WHERE complaint_id = ? AND status = 'Approved' ORDER BY id DESC LIMIT 1`,
        args: [complaint.id]
      });
      complaint.completion_report = reportRes.rows[0] || null;

      res.json(complaint);
    } catch (err) {
      console.error('Error tracking complaint:', err);
      res.status(500).json({ error: 'Failed to track complaint.' });
    }
  });

  return router;
};
