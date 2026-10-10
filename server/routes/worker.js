const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { authenticateWorker, JWT_SECRET } = require('../middleware/auth');

// Note: Cloudinary was configured in complaints.js, but since it relies on global config,
// we just define the storage here identically.
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

const router = express.Router();

module.exports = function (db) {
  // POST /api/worker/login
  router.post('/login', async (req, res) => {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required.' });
      }

      const result = await db.execute({
        sql: 'SELECT * FROM workers WHERE username = ?',
        args: [username]
      });
      const worker = result.rows[0];

      if (!worker || !bcrypt.compareSync(password, worker.password_hash)) {
        return res.status(401).json({ error: 'Invalid username or password.' });
      }

      if (worker.is_active === 0) {
        return res.status(403).json({ error: 'Your account has been deactivated.' });
      }

      const token = jwt.sign(
        { id: worker.id, username: worker.username, name: worker.name, role: 'worker' },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      res.json({ message: 'Login successful', token, name: worker.name });
    } catch (err) {
      console.error('Worker login error:', err);
      res.status(500).json({ error: 'Login failed.' });
    }
  });

  // GET /api/worker/tasks
  router.get('/tasks', authenticateWorker(db), async (req, res) => {
    try {
      const workerId = req.worker.id;

      // Find all complaints assigned to teams this worker is a member of
      const query = `
        SELECT c.id, c.complaint_id, c.category, c.description, c.location, 
               c.status, c.assigned_team, c.deadline, c.created_at, c.updated_at, c.leader_id
        FROM complaints c
        JOIN teams t ON c.team_id = t.id
        JOIN team_memberships tm ON t.id = tm.team_id
        WHERE tm.worker_id = ? AND t.is_active = 1
        ORDER BY c.created_at DESC
      `;
      
      const result = await db.execute({ sql: query, args: [workerId] });
      const complaints = result.rows;

      // Attach worker_ids from complaint_workers so the frontend knows if they are personally assigned
      // We only fetch for the complaints returned above to optimize
      if (complaints.length > 0) {
        const cIds = complaints.map(c => c.id).join(',');
        
        // 1. Fetch assigned workers
        const cwResult = await db.execute(`SELECT complaint_id, worker_id FROM complaint_workers WHERE complaint_id IN (${cIds})`);
        const cwMap = {};
        cwResult.rows.forEach(row => {
          if (!cwMap[row.complaint_id]) cwMap[row.complaint_id] = [];
          cwMap[row.complaint_id].push(row.worker_id);
        });

        // 2. Fetch latest work_reports for rejection reasons if status is In Progress
        const rResult = await db.execute(`
          SELECT complaint_id, rejection_reason 
          FROM work_reports 
          WHERE complaint_id IN (${cIds}) AND status = 'Rejected'
          ORDER BY created_at DESC
        `);
        const rMap = {};
        rResult.rows.forEach(row => {
          // Only keep the most recent rejection reason
          if (!rMap[row.complaint_id] && row.rejection_reason) {
            rMap[row.complaint_id] = row.rejection_reason;
          }
        });

        // Get names of responsible workers
        const wResult = await db.execute(`SELECT id, name FROM workers`);
        const workerNames = {};
        wResult.rows.forEach(w => workerNames[w.id] = w.name);

        complaints.forEach(c => {
          const assignedIds = cwMap[c.id] || [];
          c.is_team_leader = String(c.leader_id) === String(workerId);
          c.responsible_workers = assignedIds.map(id => workerNames[id] || 'Unknown').join(', ');
          
          if (c.status === 'In Progress' && rMap[c.id]) {
            c.rejection_reason = rMap[c.id];
          }
        });
      }

      res.json(complaints);
    } catch (err) {
      console.error('Error fetching worker tasks:', err);
      res.status(500).json({ error: 'Failed to fetch tasks.' });
    }
  });

  // PATCH /api/worker/tasks/:id/start
  router.patch('/tasks/:id/start', authenticateWorker(db), async (req, res) => {
    try {
      const workerId = req.worker.id;
      const complaintId = req.params.id;

      // 1. Complaint must exist
      const cRes = await db.execute({
        sql: 'SELECT * FROM complaints WHERE id = ?',
        args: [complaintId]
      });
      const complaint = cRes.rows[0];
      if (!complaint) {
        return res.status(404).json({ error: 'Complaint not found.' });
      }

      // 2. (Removed personal assignment check) Any active team member can start work
      
      // 3. Worker must currently belong to the active assigned team
      if (!complaint.team_id) {
         return res.status(403).json({ error: 'This task is not assigned to a team.' });
      }
      
      const teamRes = await db.execute({
        sql: `
          SELECT t.is_active 
          FROM team_memberships tm
          JOIN teams t ON tm.team_id = t.id
          WHERE tm.team_id = ? AND tm.worker_id = ?
        `,
        args: [complaint.team_id, workerId]
      });
      
      if (teamRes.rows.length === 0) {
        return res.status(403).json({ error: 'You no longer have access to this team.' });
      }
      
      if (teamRes.rows[0].is_active === 0) {
        return res.status(403).json({ error: 'The team assigned to this task is deactivated.' });
      }

      // 4. Valid state transition check
      if (complaint.status !== 'Assigned') {
        return res.status(400).json({ error: `Cannot start work: Task is currently '${complaint.status}' (Must be 'Assigned').` });
      }

      const newStatus = 'In Progress';
      const statements = [
        {
          sql: `UPDATE complaints SET status = ?, status_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
          args: [newStatus, complaintId]
        },
        {
          sql: `INSERT INTO status_history (complaint_id, status, notes) VALUES (?, ?, ?)`,
          args: [complaintId, newStatus, `Work started by ${req.worker.name}`]
        }
      ];

      await db.batch(statements, 'write');

      res.json({ message: 'Work started successfully', status: newStatus });
    } catch (err) {
      console.error('Error starting work:', err);
      res.status(500).json({ error: 'Failed to start work.' });
    }
  });

  // POST /api/worker/tasks/:id/report
  router.post('/tasks/:id/report', authenticateWorker(db), upload.single('image'), async (req, res) => {
    
    // Helper to cleanup uploaded file on early return
    const cleanupUpload = () => {
      if (req.file && req.file.filename) {
        cloudinary.uploader.destroy(req.file.filename).catch(e => console.error('Failed to clean up Cloudinary asset:', e));
      }
    };

    try {
      const workerId = req.worker.id;
      const complaintId = req.params.id;
      const { notes } = req.body;
      const imagePath = req.file ? req.file.path : null;

      if (!notes) {
        cleanupUpload();
        return res.status(400).json({ error: 'Completion notes are required.' });
      }
      if (!imagePath) {
        return res.status(400).json({ error: 'Evidence photo is required.' });
      }

      // 1. Complaint must exist
      const cRes = await db.execute({
        sql: 'SELECT * FROM complaints WHERE id = ?',
        args: [complaintId]
      });
      const complaint = cRes.rows[0];
      if (!complaint) {
        cleanupUpload();
        return res.status(404).json({ error: 'Complaint not found.' });
      }

      // 2. Worker must be designated team leader
      if (String(complaint.leader_id) !== String(workerId)) {
        cleanupUpload();
        return res.status(403).json({ error: 'Only the designated team leader can submit the completion report.' });
      }
      
      // 3. Worker must currently belong to the active assigned team
      if (!complaint.team_id) {
         cleanupUpload();
         return res.status(403).json({ error: 'This task is not assigned to a team.' });
      }
      
      const teamRes = await db.execute({
        sql: `
          SELECT t.is_active 
          FROM team_memberships tm
          JOIN teams t ON tm.team_id = t.id
          WHERE tm.team_id = ? AND tm.worker_id = ?
        `,
        args: [complaint.team_id, workerId]
      });
      
      if (teamRes.rows.length === 0 || teamRes.rows[0].is_active === 0) {
        cleanupUpload();
        return res.status(403).json({ error: 'Unauthorized: Team access revoked or team deactivated.' });
      }

      // 4. Valid state transition check
      if (complaint.status !== 'In Progress') {
        cleanupUpload();
        return res.status(400).json({ error: `Cannot submit report: Task is currently '${complaint.status}' (Must be 'In Progress').` });
      }

      // 5. Ensure no other unresolved pending report exists
      const pendingRes = await db.execute({
        sql: `SELECT id FROM work_reports WHERE complaint_id = ? AND status = 'Pending'`,
        args: [complaintId]
      });
      if (pendingRes.rows.length > 0) {
        cleanupUpload();
        return res.status(400).json({ error: 'A pending report already exists for this task. Please wait for admin verification.' });
      }

      const newStatus = 'Awaiting Admin Verification';
      const tx = await db.transaction('write');
      try {
        const updateRes = await tx.execute({
          sql: `UPDATE complaints SET status = ?, status_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'In Progress'`,
          args: [newStatus, complaintId]
        });

        if (updateRes.rowsAffected === 0) {
          await tx.rollback();
          // Clean up orphaned Cloudinary asset because the DB transition failed
          if (req.file && req.file.filename) {
            cloudinary.uploader.destroy(req.file.filename).catch(e => console.error('Failed to clean up Cloudinary asset:', e));
          }
          return res.status(409).json({ error: 'Conflict: Task is no longer In Progress or was already submitted.' });
        }

        await tx.execute({
          sql: `INSERT INTO work_reports (complaint_id, worker_id, notes, image_path, status) VALUES (?, ?, ?, ?, 'Pending')`,
          args: [complaintId, workerId, notes, imagePath]
        });

        await tx.execute({
          sql: `INSERT INTO status_history (complaint_id, status, notes) VALUES (?, ?, ?)`,
          args: [complaintId, newStatus, `Completion report submitted by ${req.worker.name}`]
        });

        await tx.commit();
      } catch (e) {
        await tx.rollback();
        throw e;
      }

      res.json({ message: 'Completion report submitted successfully', status: newStatus });
    } catch (err) {
      console.error('Error submitting report:', err);
      // Clean up orphaned Cloudinary asset if DB batch fails
      if (req.file && req.file.filename) {
        cloudinary.uploader.destroy(req.file.filename).catch(e => console.error('Failed to clean up Cloudinary asset:', e));
      }
      res.status(500).json({ error: 'Failed to submit report.' });
    }
  });

  return router;
};
