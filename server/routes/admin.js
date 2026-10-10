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
      const { status, assigned_team, worker_id, deadline } = req.body;
      const { id } = req.params;

      const result = await db.execute({
        sql: 'SELECT * FROM complaints WHERE id = ?',
        args: [id]
      });
      const complaint = result.rows[0];
      
      if (!complaint) {
        return res.status(404).json({ error: 'Complaint not found.' });
      }

      let newWorkerId = complaint.worker_id;
      let newTeam = assigned_team !== undefined ? assigned_team : complaint.assigned_team;

      if (worker_id !== undefined) {
        if (worker_id === null || worker_id === '') {
          newWorkerId = null;
          // Restore legacy team if it exists
          newTeam = complaint.legacy_assigned_team || null;
        } else {
          const workerRes = await db.execute({
            sql: 'SELECT * FROM workers WHERE id = ?',
            args: [worker_id]
          });
          const worker = workerRes.rows[0];
          if (!worker) {
            return res.status(400).json({ error: 'Invalid worker ID.' });
          }
          if (worker.is_active === 0) {
            return res.status(400).json({ error: 'Cannot assign to an inactive worker.' });
          }
          newWorkerId = worker.id;
          newTeam = worker.name;
        }
      }

      let newDeadline = complaint.deadline;
      if (deadline !== undefined) {
        if (deadline === null || deadline === '') {
          newDeadline = null;
        } else {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
            return res.status(400).json({ error: 'Deadline must be in YYYY-MM-DD format.' });
          }
          const dateObj = new Date(deadline);
          if (isNaN(dateObj.getTime()) || deadline !== dateObj.toISOString().split('T')[0]) {
            return res.status(400).json({ error: 'Invalid calendar date.' });
          }
          newDeadline = deadline;
        }
      }

      const newStatus = status || complaint.status;

      await db.execute({
        sql: `UPDATE complaints SET status = ?, assigned_team = ?, worker_id = ?, deadline = ?, updated_at = datetime('now') WHERE id = ?`,
        args: [newStatus, newTeam, newWorkerId, newDeadline, id]
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

  // DELETE /api/admin/complaints/:id — Delete a complaint
  router.delete('/complaints/:id', authenticateAdmin, async (req, res) => {
    try {
      const { id } = req.params;

      const result = await db.execute({
        sql: 'SELECT * FROM complaints WHERE id = ?',
        args: [id]
      });

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Complaint not found.' });
      }

      await db.execute({
        sql: 'DELETE FROM complaints WHERE id = ?',
        args: [id]
      });

      res.json({ message: 'Complaint deleted successfully.' });
    } catch (err) {
      console.error('Error deleting complaint:', err);
      res.status(500).json({ error: 'Failed to delete complaint.' });
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

  // --- PHASE 2 WORKER ENDPOINTS ---

  // GET /api/admin/workers — List all workers
  router.get('/workers', authenticateAdmin, async (req, res) => {
    try {
      const result = await db.execute('SELECT id, username, name, phone, is_active FROM workers');
      res.json(result.rows);
    } catch (err) {
      console.error('Error fetching workers:', err);
      res.status(500).json({ error: 'Failed to fetch workers.' });
    }
  });

  // POST /api/admin/workers — Create a new worker
  router.post('/workers', authenticateAdmin, async (req, res) => {
    try {
      const { name, phone, username, password } = req.body;
      if (!name || !phone || !username || !password) {
        return res.status(400).json({ error: 'Name, phone, username, and password are required.' });
      }
      if (!/^\d{10}$/.test(phone)) {
        return res.status(400).json({ error: 'Mobile number must be exactly 10 digits.' });
      }

      const hash = bcrypt.hashSync(password, 10);

      try {
        await db.execute({
          sql: 'INSERT INTO workers (username, password_hash, name, phone, is_active) VALUES (?, ?, ?, ?, 1)',
          args: [username, hash, name, phone]
        });
        res.status(201).json({ message: 'Worker created successfully' });
      } catch (dbErr) {
        if (dbErr.message.includes('UNIQUE constraint failed')) {
          return res.status(400).json({ error: 'Username already exists.' });
        }
        throw dbErr;
      }
    } catch (err) {
      console.error('Error creating worker:', err);
      res.status(500).json({ error: 'Failed to create worker.' });
    }
  });

  // PATCH /api/admin/workers/:id — Toggle active status
  router.patch('/workers/:id', authenticateAdmin, async (req, res) => {
    try {
      const { is_active } = req.body;
      const { id } = req.params;

      if (is_active === undefined) {
        return res.status(400).json({ error: 'is_active field is required.' });
      }

      await db.execute({
        sql: 'UPDATE workers SET is_active = ? WHERE id = ?',
        args: [is_active ? 1 : 0, id]
      });
      res.json({ message: 'Worker status updated successfully' });
    } catch (err) {
      console.error('Error updating worker status:', err);
      res.status(500).json({ error: 'Failed to update worker status.' });
    }
  });

  return router;
};
