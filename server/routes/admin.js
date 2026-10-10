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
      const complaints = result.rows;

      // Attach worker_ids from complaint_workers
      const cwResult = await db.execute('SELECT complaint_id, worker_id FROM complaint_workers');
      const cwMap = {};
      cwResult.rows.forEach(row => {
        if (!cwMap[row.complaint_id]) cwMap[row.complaint_id] = [];
        cwMap[row.complaint_id].push(row.worker_id);
      });

      complaints.forEach(c => {
        c.worker_ids = cwMap[c.id] || (c.worker_id ? [c.worker_id] : []);
      });

      res.json(complaints);
    } catch (err) {
      console.error('Error fetching complaints:', err);
      res.status(500).json({ error: 'Failed to fetch complaints.' });
    }
  });  // PATCH /api/admin/complaints/:id — Update complaint status/assignment
  router.patch('/complaints/:id', authenticateAdmin, async (req, res) => {
    try {
      const { status, assigned_team, worker_id, deadline, team_id, worker_ids, leader_id } = req.body;
      const { id } = req.params;

      const result = await db.execute({
        sql: 'SELECT * FROM complaints WHERE id = ?',
        args: [id]
      });
      const complaint = result.rows[0];
      
      if (!complaint) {
        return res.status(404).json({ error: 'Complaint not found.' });
      }

      // Prevent mixing new vs legacy models
      const hasNewModel = (team_id !== undefined || worker_ids !== undefined);
      const hasLegacyModel = (assigned_team !== undefined || worker_id !== undefined);
      if (hasNewModel && hasLegacyModel) {
        return res.status(400).json({ error: 'Cannot mix new assignment model (team_id/worker_ids) with legacy model (assigned_team/worker_id).' });
      }

      let newTeamId = complaint.team_id;
      let newAssignedTeam = complaint.assigned_team;
      let newWorkerId = complaint.worker_id;
      
      // Statements array for the atomic batch write
      const statements = [];

      // 1. Process Team Assignment
      if (team_id !== undefined) {
        if (team_id === null || team_id === '') {
          newTeamId = null;
          newAssignedTeam = complaint.legacy_assigned_team || null;
          newWorkerId = null;
          statements.push({ sql: 'DELETE FROM complaint_workers WHERE complaint_id = ?', args: [id] });
        } else {
          const teamRes = await db.execute({ sql: 'SELECT * FROM teams WHERE id = ?', args: [team_id] });
          const team = teamRes.rows[0];
          if (!team) return res.status(400).json({ error: 'Invalid team ID.' });
          if (team.is_active === 0) return res.status(400).json({ error: 'Cannot assign to an inactive team.' });
          
          newTeamId = team.id;
          newAssignedTeam = team.name; // Keep legacy string in sync
          
          // If team changed, clear incompatible workers
          if (complaint.team_id !== newTeamId) {
            statements.push({ sql: 'DELETE FROM complaint_workers WHERE complaint_id = ?', args: [id] });
            newWorkerId = null;
          }
        }
      } 
      // Fallback for Phase 2 legacy team assignment
      else if (assigned_team !== undefined) {
        newAssignedTeam = assigned_team;
      }

      // 2. Process Worker Assignments
      if (worker_ids !== undefined) {
        if (!Array.isArray(worker_ids)) return res.status(400).json({ error: 'worker_ids must be an array.' });
        
        if (worker_ids.length > 0 && !newTeamId) {
          return res.status(400).json({ error: 'Cannot assign workers without an assigned team.' });
        }
        
        // Deduplicate
        const uniqueWorkerIds = [...new Set(worker_ids)];
        
        // Clear current
        statements.push({ sql: 'DELETE FROM complaint_workers WHERE complaint_id = ?', args: [id] });
        newWorkerId = null;
        
        for (const wid of uniqueWorkerIds) {
          // Validate worker
          const wRes = await db.execute({ sql: 'SELECT * FROM workers WHERE id = ?', args: [wid] });
          const worker = wRes.rows[0];
          if (!worker) return res.status(400).json({ error: `Invalid worker ID: ${wid}` });
          if (worker.is_active === 0) return res.status(400).json({ error: `Worker ${worker.name} is inactive.` });
          
          // Validate membership
          const memRes = await db.execute({ 
            sql: 'SELECT * FROM team_memberships WHERE team_id = ? AND worker_id = ?', 
            args: [newTeamId, wid] 
          });
          if (memRes.rows.length === 0) {
            return res.status(400).json({ error: `Worker ${worker.name} does not belong to the assigned team.` });
          }
          
          statements.push({
            sql: 'INSERT INTO complaint_workers (complaint_id, worker_id) VALUES (?, ?)',
            args: [id, wid]
          });
        }
        if (uniqueWorkerIds.length > 0) newWorkerId = uniqueWorkerIds[0];
      } 
      // Fallback for Phase 2 legacy worker_id assignment
      else if (worker_id !== undefined) {
        if (worker_id === null || worker_id === '') {
          newWorkerId = null;
          newAssignedTeam = complaint.legacy_assigned_team || null;
          statements.push({ sql: 'DELETE FROM complaint_workers WHERE complaint_id = ?', args: [id] });
        } else {
          const wRes = await db.execute({ sql: 'SELECT * FROM workers WHERE id = ?', args: [worker_id] });
          const worker = wRes.rows[0];
          if (!worker) return res.status(400).json({ error: 'Invalid worker ID.' });
          if (worker.is_active === 0) return res.status(400).json({ error: 'Cannot assign to an inactive worker.' });
          
          newWorkerId = worker.id;
          newAssignedTeam = worker.name;
          statements.push({ sql: 'DELETE FROM complaint_workers WHERE complaint_id = ?', args: [id] });
          statements.push({ sql: 'INSERT INTO complaint_workers (complaint_id, worker_id) VALUES (?, ?)', args: [id, worker.id] });
        }
      }
      // 2.5 Process Leader ID
      let newLeaderId = complaint.leader_id;
      if (leader_id !== undefined) {
        if (leader_id === null || leader_id === '') {
          newLeaderId = null;
        } else {
          if (!newTeamId) {
            return res.status(400).json({ error: 'Cannot assign a leader without an assigned team.' });
          }
          const wRes = await db.execute({ sql: 'SELECT * FROM workers WHERE id = ?', args: [leader_id] });
          const worker = wRes.rows[0];
          if (!worker) return res.status(400).json({ error: 'Invalid leader ID.' });
          if (worker.is_active === 0) return res.status(400).json({ error: 'Leader must be an active worker.' });

          const memRes = await db.execute({ 
            sql: 'SELECT * FROM team_memberships WHERE team_id = ? AND worker_id = ?', 
            args: [newTeamId, leader_id] 
          });
          if (memRes.rows.length === 0) {
            return res.status(400).json({ error: 'Leader does not belong to the assigned team.' });
          }
          newLeaderId = leader_id;
        }
      }

      // 3. Process Deadline
      let newDeadline = complaint.deadline;
      if (deadline !== undefined) {
        if (deadline === null || deadline === '') {
          newDeadline = null;
        } else {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return res.status(400).json({ error: 'Deadline must be in YYYY-MM-DD format.' });
          const dateObj = new Date(deadline);
          if (isNaN(dateObj.getTime()) || deadline !== dateObj.toISOString().split('T')[0]) {
            return res.status(400).json({ error: 'Invalid calendar date.' });
          }
          newDeadline = deadline;
        }
      }

      // 4. Process Status
      const newStatus = status || complaint.status;

      // Add the final update statement
      statements.push({
        sql: `UPDATE complaints SET status = ?, assigned_team = ?, worker_id = ?, deadline = ?, team_id = ?, leader_id = ?, status_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
        args: [newStatus, newAssignedTeam, newWorkerId, newDeadline, newTeamId, newLeaderId, id]
      });

      if (newStatus !== complaint.status) {
        statements.push({
          sql: `INSERT INTO status_history (complaint_id, status, notes) VALUES (?, ?, ?)`,
          args: [id, newStatus, 'Status updated by administrator.']
        });
      }

      // Execute all mutations atomically in a single batch transaction
      await db.batch(statements, 'write');

      const updatedResult = await db.execute({ sql: 'SELECT * FROM complaints WHERE id = ?', args: [id] });
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

  // GET /api/admin/reports/pending
  router.get('/reports/pending', authenticateAdmin, async (req, res) => {
    try {
      const query = `
        SELECT r.*, c.complaint_id as complaint_ref, c.category, c.location, t.name as team_name, w.name as worker_name
        FROM work_reports r
        JOIN complaints c ON r.complaint_id = c.id
        JOIN workers w ON r.worker_id = w.id
        LEFT JOIN teams t ON c.team_id = t.id
        WHERE r.status = 'Pending'
        ORDER BY r.created_at ASC
      `;
      const result = await db.execute(query);
      
      const reports = result.rows;
      if (reports.length > 0) {
        const cIds = reports.map(r => r.complaint_id).join(',');
        const cwResult = await db.execute(`SELECT complaint_id, worker_id FROM complaint_workers WHERE complaint_id IN (${cIds})`);
        const wResult = await db.execute(`SELECT id, name FROM workers`);
        const workerNames = {};
        wResult.rows.forEach(w => workerNames[w.id] = w.name);
        
        const cwMap = {};
        cwResult.rows.forEach(row => {
          if (!cwMap[row.complaint_id]) cwMap[row.complaint_id] = [];
          cwMap[row.complaint_id].push(workerNames[row.worker_id] || 'Unknown');
        });
        
        reports.forEach(r => {
          r.assigned_workers = (cwMap[r.complaint_id] || []).join(', ');
        });
      }

      res.json(reports);
    } catch (err) {
      console.error('Error fetching pending reports:', err);
      res.status(500).json({ error: 'Failed to fetch reports.' });
    }
  });

  // PATCH /api/admin/complaints/:id/verify
  router.patch('/complaints/:id/verify', authenticateAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { action, reason } = req.body;
      const adminId = req.admin.id;

      if (!['Approve', 'Reject'].includes(action)) {
        return res.status(400).json({ error: 'Action must be Approve or Reject.' });
      }

      if (action === 'Reject' && (!reason || reason.trim() === '')) {
        return res.status(400).json({ error: 'A rejection reason is required.' });
      }

      const cRes = await db.execute({ sql: 'SELECT * FROM complaints WHERE id = ?', args: [id] });
      const complaint = cRes.rows[0];
      if (!complaint) return res.status(404).json({ error: 'Complaint not found.' });
      if (complaint.status !== 'Awaiting Admin Verification') {
        return res.status(400).json({ error: `Cannot verify. Complaint is currently '${complaint.status}'.` });
      }

      const rRes = await db.execute({ sql: "SELECT * FROM work_reports WHERE complaint_id = ? AND status = 'Pending'", args: [id] });
      const report = rRes.rows[0];
      if (!report) {
        return res.status(400).json({ error: 'No pending report found for this complaint.' });
      }

      const newComplaintStatus = action === 'Approve' ? 'Resolved' : 'In Progress';
      const historyNote = action === 'Approve' ? `Work approved by admin (${req.admin.username})` : `Work rejected by admin (${req.admin.username}): ${reason}`;

      const tx = await db.transaction('write');
      try {
        // 1. Conditional Update report to ensure it is still Pending
        let sqlUpdateReport;
        let argsUpdateReport;
        if (action === 'Approve') {
          sqlUpdateReport = `UPDATE work_reports SET status = 'Approved', reviewed_at = datetime('now'), reviewer_id = ? WHERE id = ? AND status = 'Pending'`;
          argsUpdateReport = [adminId, report.id];
        } else {
          sqlUpdateReport = `UPDATE work_reports SET status = 'Rejected', rejection_reason = ?, reviewed_at = datetime('now'), reviewer_id = ? WHERE id = ? AND status = 'Pending'`;
          argsUpdateReport = [reason, adminId, report.id];
        }

        const updateRes = await tx.execute({ sql: sqlUpdateReport, args: argsUpdateReport });
        if (updateRes.rowsAffected === 0) {
          await tx.rollback();
          return res.status(409).json({ error: 'Conflict: Report is no longer Pending or has already been verified.' });
        }

        // 2. Update complaint
        await tx.execute({
          sql: `UPDATE complaints SET status = ?, status_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
          args: [newComplaintStatus, id]
        });

        // 3. Insert history
        await tx.execute({
          sql: `INSERT INTO status_history (complaint_id, status, notes) VALUES (?, ?, ?)`,
          args: [id, newComplaintStatus, historyNote]
        });

        await tx.commit();
      } catch (e) {
        await tx.rollback();
        throw e;
      }

      res.json({ message: `Report ${action.toLowerCase()}ed successfully.`, status: newComplaintStatus });
    } catch (err) {
      console.error('Error verifying report:', err);
      res.status(500).json({ error: 'Failed to verify report.' });
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

  // --- PHASE 3 TEAM ENDPOINTS ---

  // GET /api/admin/teams — List all teams
  router.get('/teams', authenticateAdmin, async (req, res) => {
    try {
      const result = await db.execute('SELECT id, name, is_active, created_at FROM teams');
      res.json(result.rows);
    } catch (err) {
      console.error('Error fetching teams:', err);
      res.status(500).json({ error: 'Failed to fetch teams.' });
    }
  });

  // POST /api/admin/teams — Create a new team
  router.post('/teams', authenticateAdmin, async (req, res) => {
    try {
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: 'Team name is required.' });

      await db.execute({
        sql: 'INSERT INTO teams (name) VALUES (?)',
        args: [name]
      });
      res.status(201).json({ message: 'Team created successfully' });
    } catch (err) {
      console.error('Error creating team:', err);
      res.status(500).json({ error: 'Failed to create team.' });
    }
  });

  // PATCH /api/admin/teams/:id — Toggle active status
  router.patch('/teams/:id', authenticateAdmin, async (req, res) => {
    try {
      const { is_active } = req.body;
      const { id } = req.params;

      if (is_active === undefined) return res.status(400).json({ error: 'is_active field is required.' });

      await db.execute({
        sql: 'UPDATE teams SET is_active = ? WHERE id = ?',
        args: [is_active ? 1 : 0, id]
      });
      res.json({ message: 'Team status updated successfully' });
    } catch (err) {
      console.error('Error updating team status:', err);
      res.status(500).json({ error: 'Failed to update team status.' });
    }
  });

  // GET /api/admin/teams/:id/members — List workers in a team
  router.get('/teams/:id/members', authenticateAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const result = await db.execute({
        sql: `SELECT w.id, w.name, w.username, w.is_active 
              FROM workers w 
              JOIN team_memberships tm ON w.id = tm.worker_id 
              WHERE tm.team_id = ?`,
        args: [id]
      });
      res.json(result.rows);
    } catch (err) {
      console.error('Error fetching team members:', err);
      res.status(500).json({ error: 'Failed to fetch team members.' });
    }
  });

  // POST /api/admin/teams/:id/members — Add worker to team
  router.post('/teams/:id/members', authenticateAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { worker_id } = req.body;
      if (!worker_id) return res.status(400).json({ error: 'worker_id is required.' });

      try {
        await db.execute({
          sql: 'INSERT INTO team_memberships (team_id, worker_id) VALUES (?, ?)',
          args: [id, worker_id]
        });
        res.status(201).json({ message: 'Worker added to team' });
      } catch (dbErr) {
        if (dbErr.message.includes('UNIQUE constraint failed') || dbErr.message.includes('PRIMARY KEY constraint failed')) {
          return res.status(400).json({ error: 'Worker is already in this team.' });
        }
        throw dbErr;
      }
    } catch (err) {
      console.error('Error adding team member:', err);
      res.status(500).json({ error: 'Failed to add team member.' });
    }
  });

  // DELETE /api/admin/teams/:id/members/:workerId — Remove worker from team
  router.delete('/teams/:id/members/:workerId', authenticateAdmin, async (req, res) => {
    try {
      const { id, workerId } = req.params;
      await db.execute({
        sql: 'DELETE FROM team_memberships WHERE team_id = ? AND worker_id = ?',
        args: [id, workerId]
      });
      res.json({ message: 'Worker removed from team' });
    } catch (err) {
      console.error('Error removing team member:', err);
      res.status(500).json({ error: 'Failed to remove team member.' });
    }
  });

  // GET /api/admin/team-memberships — List all team memberships (bulk)
  router.get('/team-memberships', authenticateAdmin, async (req, res) => {
    try {
      const result = await db.execute('SELECT team_id, worker_id FROM team_memberships');
      res.json(result.rows);
    } catch (err) {
      console.error('Error fetching all team memberships:', err);
      res.status(500).json({ error: 'Failed to fetch team memberships.' });
    }
  });

  return router;
};
