const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticateAdmin, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

module.exports = function (db) {
  // POST /api/admin/login
  router.post('/login', async (req, res) => {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required.' });
      }

      const result = await db.execute({
        sql: 'SELECT * FROM admins WHERE username = ?',
        args: [username]
      });
      const admin = result.rows[0];

      if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
        return res.status(401).json({ error: 'Invalid username or password.' });
      }

      const token = jwt.sign(
        { id: admin.id, username: admin.username },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      res.json({ message: 'Login successful', token });
    } catch (err) {
      console.error('Login error:', err);
      res.status(500).json({ error: 'Login failed.' });
    }
  });

  // GET /api/admin/complaints — Get all complaints (with optional search/filter)
  router.get('/complaints', authenticateAdmin, async (req, res) => {
    try {
      const { search, status } = req.query;
      let query = 'SELECT * FROM complaints';
      const conditions = [];
      const params = [];

      if (search) {
        conditions.push('(complaint_id LIKE ? OR description LIKE ? OR location LIKE ? OR name LIKE ?)');
        const term = `%${search}%`;
        params.push(term, term, term, term);
      }

      if (status && status !== 'All') {
        conditions.push('status = ?');
        params.push(status);
      }

      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }

      query += ' ORDER BY created_at DESC';

      const result = await db.execute({ sql: query, args: params });
      res.json(result.rows);
    } catch (err) {
      console.error('Error fetching complaints:', err);
      res.status(500).json({ error: 'Failed to fetch complaints.' });
    }
  });

  // PATCH /api/admin/complaints/:id — Update complaint status/assignment
  router.patch('/complaints/:id', authenticateAdmin, async (req, res) => {
    try {
      const { status, assigned_team } = req.body;
      const { id } = req.params;

      const result = await db.execute({
        sql: 'SELECT * FROM complaints WHERE id = ?',
        args: [id]
      });
      const complaint = result.rows[0];
      
      if (!complaint) {
        return res.status(404).json({ error: 'Complaint not found.' });
      }

      const newStatus = status || complaint.status;
      const newTeam = assigned_team !== undefined ? assigned_team : complaint.assigned_team;

      await db.execute({
        sql: `UPDATE complaints SET status = ?, assigned_team = ?, updated_at = datetime('now') WHERE id = ?`,
        args: [newStatus, newTeam, id]
      });

      const updatedResult = await db.execute({
        sql: 'SELECT * FROM complaints WHERE id = ?',
        args: [id]
      });
      res.json({ message: 'Complaint updated successfully', complaint: updatedResult.rows[0] });
    } catch (err) {
      console.error('Error updating complaint:', err);
      res.status(500).json({ error: 'Failed to update complaint.' });
    }
  });

  // GET /api/admin/stats — Dashboard statistics
  router.get('/stats', authenticateAdmin, async (req, res) => {
    try {
      const totalResult = await db.execute('SELECT COUNT(*) as count FROM complaints');
      const submittedResult = await db.execute("SELECT COUNT(*) as count FROM complaints WHERE status = 'Submitted'");
      const underReviewResult = await db.execute("SELECT COUNT(*) as count FROM complaints WHERE status = 'Under Review'");
      const assignedResult = await db.execute("SELECT COUNT(*) as count FROM complaints WHERE status = 'Assigned'");
      const inProgressResult = await db.execute("SELECT COUNT(*) as count FROM complaints WHERE status = 'In Progress'");
      const resolvedResult = await db.execute("SELECT COUNT(*) as count FROM complaints WHERE status = 'Resolved'");

      res.json({ 
        total: totalResult.rows[0].count, 
        submitted: submittedResult.rows[0].count, 
        underReview: underReviewResult.rows[0].count, 
        assigned: assignedResult.rows[0].count, 
        inProgress: inProgressResult.rows[0].count, 
        resolved: resolvedResult.rows[0].count 
      });
    } catch (err) {
      console.error('Error fetching stats:', err);
      res.status(500).json({ error: 'Failed to fetch stats.' });
    }
  });

  // POST /api/admin/change-password
  router.post('/change-password', authenticateAdmin, async (req, res) => {
    try {
      const { currentPassword, newPassword, confirmPassword } = req.body;
      const adminId = req.admin.id; // from authenticateAdmin middleware

      if (!currentPassword || !newPassword || !confirmPassword) {
        return res.status(400).json({ error: 'All fields are required.' });
      }

      if (newPassword !== confirmPassword) {
        return res.status(400).json({ error: 'New passwords do not match.' });
      }

      const result = await db.execute({
        sql: 'SELECT * FROM admins WHERE id = ?',
        args: [adminId]
      });
      const admin = result.rows[0];

      if (!admin || !bcrypt.compareSync(currentPassword, admin.password_hash)) {
        return res.status(401).json({ error: 'Incorrect current password.' });
      }

      const hash = bcrypt.hashSync(newPassword, 10);
      await db.execute({
        sql: 'UPDATE admins SET password_hash = ? WHERE id = ?',
        args: [hash, adminId]
      });

      res.json({ message: 'Password changed successfully!' });
    } catch (err) {
      console.error('Change password error:', err);
      res.status(500).json({ error: 'Failed to change password.' });
    }
  });

  return router;
};
