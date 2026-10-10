/* ============================================
   AquaCare — Frontend Application Logic
   ============================================ */

const API = ''; // Same origin — no prefix needed

// --- State ---
let currentPage = 'home';
let adminToken = sessionStorage.getItem('aquacare_token') || null;
let lastComplaintId = null;
let searchTimeout = null;
let allWorkers = [];
let allTeams = [];
let allTeamMemberships = [];

// --- Navigation ---
function navigateTo(page) {
  currentPage = page;
  const app = document.getElementById('app');
  closeMobileMenu();

  // If trying to access dashboard without token, redirect to login
  if (page === 'dashboard' && !adminToken) {
    page = 'admin-login';
    currentPage = page;
  }

  // Load template
  const template = document.getElementById(`tpl-${page}`);
  if (template) {
    app.innerHTML = '';
    app.appendChild(template.content.cloneNode(true));
  }

  // Update active nav link
  document.querySelectorAll('.nav-links a').forEach(a => {
    a.classList.toggle('active', a.dataset.page === page);
  });

  // Page-specific init
  if (page === 'confirmation' && lastComplaintId) {
    document.getElementById('confirmationId').textContent = lastComplaintId;
  }
  if (page === 'dashboard') {
    loadStats();
    loadPendingReports();
    loadComplaints();
  }

  // Scroll to top
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toggleMobileMenu() {
  document.getElementById('mobileMenu').classList.toggle('show');
}

function closeMobileMenu() {
  document.getElementById('mobileMenu').classList.remove('show');
}

// --- Complaint Submission ---
async function submitComplaint(e) {
  e.preventDefault();
  const phoneVal = document.getElementById('phone').value.trim();
  if (!/^\d{10}$/.test(phoneVal)) {
    showToast('Mobile number must be exactly 10 digits.', 'error');
    return;
  }

  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="material-icons-round">hourglass_top</span> Submitting...';

  const form = document.getElementById('reportForm');
  const formData = new FormData(form);

  try {
    const res = await fetch(`${API}/api/complaints`, {
      method: 'POST',
      body: formData
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Failed to submit complaint');
    }

    lastComplaintId = data.complaintId;
    navigateTo('confirmation');
    showToast('Complaint submitted successfully!', 'success');
  } catch (err) {
    showToast(err.message, 'error');
    btn.disabled = false;
    btn.innerHTML = '<span class="material-icons-round">send</span> Submit Complaint';
  }
}

// --- Image Preview ---
function openPhotoChoiceModal() {
  document.getElementById('photoChoiceModal').style.display = 'flex';
}

function closePhotoChoiceModal() {
  document.getElementById('photoChoiceModal').style.display = 'none';
}

function triggerCamera() {
  closePhotoChoiceModal();
  const input = document.getElementById('image');
  input.setAttribute('capture', 'environment');
  input.click();
}

function triggerGallery() {
  closePhotoChoiceModal();
  const input = document.getElementById('image');
  input.removeAttribute('capture');
  input.click();
}

function previewImage(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (event) {
    document.getElementById('previewImg').src = event.target.result;
    document.getElementById('filePreview').style.display = 'block';
    document.getElementById('uploadPlaceholder').style.display = 'none';
  };
  reader.readAsDataURL(file);
}

function clearImage() {
  document.getElementById('image').value = '';
  document.getElementById('filePreview').style.display = 'none';
  document.getElementById('uploadPlaceholder').style.display = 'block';
}

// --- Copy Complaint ID ---
function copyComplaintId() {
  if (!lastComplaintId) return;
  navigator.clipboard.writeText(lastComplaintId).then(() => {
    showToast('Complaint ID copied!', 'success');
  });
}

// --- Track Complaint ---
async function trackComplaint() {
  const input = document.getElementById('trackInput');
  const id = input.value.trim().toUpperCase();
  const resultDiv = document.getElementById('trackResult');

  if (!id) {
    showToast('Please enter a Complaint ID', 'error');
    return;
  }

  resultDiv.innerHTML = '<p class="loading-text">Searching...</p>';

  try {
    const res = await fetch(`${API}/api/complaints/track/${encodeURIComponent(id)}`);
    const data = await res.json();

    if (!res.ok) {
      resultDiv.innerHTML = `<div class="track-result-card"><div class="empty-state"><span class="material-icons-round">search_off</span><p>${data.error}</p></div></div>`;
      return;
    }

    // Render result
    const template = document.getElementById('tpl-track-result');
    const clone = template.content.cloneNode(true);

    clone.querySelector('.track-result-id').textContent = data.complaint_id;
    clone.querySelector('.detail-name').textContent = data.name;
    clone.querySelector('.detail-location').textContent = data.location;
    clone.querySelector('.detail-description').textContent = data.description;
    clone.querySelector('.track-result-date').textContent = formatDate(data.created_at);

    // Status badge
    const badge = clone.querySelector('.status-badge');
    badge.textContent = data.status;
    badge.className = 'status-badge ' + getStatusClass(data.status);

    // Assigned team
    if (data.team_name) {
      const teamEl = clone.querySelector('.detail-team');
      teamEl.style.display = 'block';
      clone.querySelector('.detail-assigned').textContent = data.team_name;
    }

    // Assigned workers
    if (data.assigned_workers && data.assigned_workers.length > 0) {
      const workersEl = clone.querySelector('.detail-workers');
      workersEl.style.display = 'block';
      clone.querySelector('.detail-workers-text').textContent = data.assigned_workers.join(', ');
    }

    // Deadline & Overdue
    if (data.deadline) {
      const deadlineEl = clone.querySelector('.detail-deadline');
      deadlineEl.style.display = 'block';
      clone.querySelector('.detail-deadline-text').textContent = formatDate(data.deadline);
      if (data.isOverdue) {
        clone.querySelector('.detail-overdue-badge').style.display = 'inline-block';
      }
    }

    // Image
    if (data.image_path) {
      const imgContainer = clone.querySelector('.track-image-container');
      imgContainer.style.display = 'block';
      clone.querySelector('.track-image').src = data.image_path;
    }

    // Status History Timeline
    const timelineList = clone.querySelector('#timelineList');
    const timelineEmpty = clone.querySelector('#timelineEmpty');
    if (data.status_history && data.status_history.length > 0) {
      data.status_history.forEach(history => {
        const li = document.createElement('li');
        li.style.marginBottom = '10px';
        li.innerHTML = `
          <div style="font-weight:bold; color:#333;">${history.status} <span style="font-weight:normal; color:#888; font-size:0.85rem; margin-left:8px;">${formatDate(history.created_at)}</span></div>
          <div style="margin-top:2px;">${escapeHtml(history.notes || '')}</div>
        `;
        timelineList.appendChild(li);
      });
    } else {
      timelineEmpty.style.display = 'block';
    }

    // Approved Completion Evidence
    if (data.completion_report) {
      const evidenceEl = clone.querySelector('#completionEvidence');
      evidenceEl.style.display = 'block';
      clone.querySelector('#completionNotes').textContent = data.completion_report.notes;
      if (data.completion_report.image_path) {
        const imgContainer = clone.querySelector('#completionImageContainer');
        imgContainer.style.display = 'block';
        const img = clone.querySelector('#completionImage');
        img.src = data.completion_report.image_path.startsWith('http') ? data.completion_report.image_path : `${API}/${data.completion_report.image_path}`;
      }
    }

    // Progress tracker
    // Maintain Awaiting Admin Verification as part of In Progress step for the tracker bar, or just Resolved if it's Resolved.
    const trackerStatus = data.status === 'Awaiting Admin Verification' ? 'In Progress' : data.status;
    const statuses = ['Submitted', 'Under Review', 'Assigned', 'In Progress', 'Resolved'];
    const currentIdx = statuses.indexOf(trackerStatus);
    const steps = clone.querySelectorAll('.progress-step');
    const lines = clone.querySelectorAll('.progress-line');

    steps.forEach((step, i) => {
      if (i < currentIdx) step.classList.add('completed');
      else if (i === currentIdx) step.classList.add('current');
    });

    lines.forEach((line, i) => {
      if (i < currentIdx) line.classList.add('filled');
    });

    resultDiv.innerHTML = '';
    resultDiv.appendChild(clone);
  } catch (err) {
    resultDiv.innerHTML = `<div class="track-result-card"><div class="empty-state"><span class="material-icons-round">error</span><p>Something went wrong. Please try again.</p></div></div>`;
  }
}

// --- Admin Login ---
async function adminLogin(e) {
  e.preventDefault();
  const username = document.getElementById('adminUser').value.trim();
  const password = document.getElementById('adminPass').value;
  const errorDiv = document.getElementById('loginError');

  try {
    const res = await fetch(`${API}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();

    if (!res.ok) {
      errorDiv.textContent = data.error;
      errorDiv.style.display = 'block';
      return;
    }

    adminToken = data.token;
    sessionStorage.setItem('aquacare_token', adminToken);

    // Update nav
    const adminLinks = document.querySelectorAll('[data-page="admin-login"]');
    adminLinks.forEach(link => {
      link.textContent = 'Dashboard';
      link.setAttribute('onclick', "navigateTo('dashboard')");
      link.dataset.page = 'dashboard';
    });

    navigateTo('dashboard');
    showToast('Logged in successfully!', 'success');
  } catch (err) {
    errorDiv.textContent = 'Connection error. Please try again.';
    errorDiv.style.display = 'block';
  }
}

function adminLogout() {
  adminToken = null;
  sessionStorage.removeItem('aquacare_token');

  // Reset nav
  const dashboardLinks = document.querySelectorAll('[data-page="dashboard"]');
  dashboardLinks.forEach(link => {
    link.textContent = link.classList.contains('nav-admin-btn') ? 'Admin' : 'Admin Portal';
    link.setAttribute('onclick', "navigateTo('admin-login')");
    link.dataset.page = 'admin-login';
  });

  navigateTo('home');
  showToast('Logged out.', 'success');
}

// --- Admin Change Password ---
function showChangePasswordModal() {
  document.getElementById('changePasswordModal').style.display = 'flex';
  document.getElementById('currentPassword').value = '';
  document.getElementById('newPassword').value = '';
  document.getElementById('confirmPassword').value = '';
  document.getElementById('pwdError').style.display = 'none';
}

function closeChangePasswordModal() {
  document.getElementById('changePasswordModal').style.display = 'none';
}

async function changePassword(e) {
  e.preventDefault();
  const currentPassword = document.getElementById('currentPassword').value;
  const newPassword = document.getElementById('newPassword').value;
  const confirmPassword = document.getElementById('confirmPassword').value;
  const errorDiv = document.getElementById('pwdError');

  if (newPassword !== confirmPassword) {
    errorDiv.textContent = 'New passwords do not match.';
    errorDiv.style.display = 'block';
    return;
  }

  try {
    const res = await fetch(`${API}/api/admin/change-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
    });

    const data = await res.json();

    if (!res.ok) {
      errorDiv.textContent = data.error;
      errorDiv.style.display = 'block';
      if (res.status === 401 && data.error === 'Token expired') {
        adminLogout();
      }
      return;
    }

    closeChangePasswordModal();
    showToast('Password changed successfully!', 'success');
  } catch (err) {
    errorDiv.textContent = 'Connection error. Please try again.';
    errorDiv.style.display = 'block';
  }
}

// --- Dashboard: Load Stats ---
async function loadStats() {
  try {
    const res = await fetch(`${API}/api/admin/stats`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });

    if (res.status === 401) { adminLogout(); return; }
    const data = await res.json();

    document.getElementById('statTotal').textContent = data.total;
    document.getElementById('statSubmitted').textContent = data.submitted;
    document.getElementById('statReview').textContent = data.underReview;
    document.getElementById('statAssigned').textContent = data.assigned;
    document.getElementById('statProgress').textContent = data.inProgress;
    document.getElementById('statResolved').textContent = data.resolved;
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

// --- Dashboard: Load Complaints ---
async function loadComplaints() {
  const listDiv = document.getElementById('complaintsList');
  if (!listDiv) return;

  const search = document.getElementById('searchInput')?.value || '';
  const status = document.getElementById('statusFilter')?.value || 'All';

  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (status !== 'All') params.set('status', status);

  try {
    const res = await fetch(`${API}/api/admin/complaints?${params}`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });

    if (res.status === 401) { adminLogout(); return; }
    const complaints = await res.json();
    
    await fetchWorkers(); // Ensure workers are loaded before rendering
    await fetchTeams();   // Ensure teams are loaded before rendering

    if (complaints.length === 0) {
      listDiv.innerHTML = `<div class="empty-state"><span class="material-icons-round">inbox</span><p>No complaints found.</p></div>`;
      return;
    }

    listDiv.innerHTML = complaints.map(c => renderComplaintCard(c)).join('');
  } catch (err) {
    listDiv.innerHTML = '<p class="loading-text">Failed to load complaints.</p>';
  }
}

function renderComplaintCard(c) {
  const statusOptions = ['Submitted', 'Under Review', 'Assigned', 'In Progress', 'Resolved']
    .map(s => `<option value="${s}" ${s === c.status ? 'selected' : ''}>${s}</option>`)
    .join('');

  const imageHtml = c.image_path
    ? `<img class="complaint-card-image" src="${c.image_path}" alt="Complaint photo" onclick="window.open('${c.image_path}', '_blank')">`
    : '';

  let isOverdue = false;
  if (c.deadline && c.status !== 'Resolved') {
    const todayDate = new Date();
    // Create local YYYY-MM-DD string
    const yyyy = todayDate.getFullYear();
    const mm = String(todayDate.getMonth() + 1).padStart(2, '0');
    const dd = String(todayDate.getDate()).padStart(2, '0');
    const todayLocalStr = `${yyyy}-${mm}-${dd}`;
    
    // Strict string comparison (YYYY-MM-DD format allows alphabetical comparison)
    if (todayLocalStr > c.deadline) {
      isOverdue = true;
    }
  }
  const overdueBadge = isOverdue ? `<span class="status-badge" style="background:#ffebee; color:#d32f2f;">[OVERDUE]</span>` : '';

  let teamOptions = `<option value="">Unassigned</option>`;
  allTeams.filter(t => t.is_active || t.id === c.team_id).forEach(t => {
    teamOptions += `<option value="${t.id}" ${t.id === c.team_id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`;
  });

  const workerOptions = getWorkerOptionsForTeam(c.team_id, c.leader_id || null);
  
  const legacyTeam = (c.assigned_team && !c.team_id && !c.worker_id && !c.leader_id) ? `<small style="color:#666; margin-left:8px;">Legacy Team: ${escapeHtml(c.assigned_team)}</small>` : '';

  const leaderWorker = allWorkers.find(w => String(w.id) === String(c.leader_id));
  const leaderDetail = leaderWorker ? `<p><strong>Team Leader:</strong> <span class="status-badge" style="background:#e3f2fd; color:#1976d2;">${escapeHtml(leaderWorker.name)}</span></p>` : '';

  return `
    <div class="complaint-card" id="card-${c.id}">
      <div class="complaint-card-header">
        <div>
          <span class="complaint-card-id">${c.complaint_id}</span>
          <span class="status-badge ${getStatusClass(c.status)}">${c.status}</span>
          ${overdueBadge}
        </div>
        <span class="complaint-card-date">${formatDate(c.created_at)}</span>
      </div>
      <div class="complaint-card-body">
        <div class="complaint-card-details">
          <p><strong>Name:</strong> ${escapeHtml(c.name)}</p>
          <p><strong>Phone:</strong> ${escapeHtml(c.phone)}</p>
          <p><strong>Category:</strong> ${escapeHtml(c.category || 'Other')}</p>
          <p><strong>Location:</strong> ${escapeHtml(c.location)}</p>
          <p><strong>Description:</strong> ${escapeHtml(c.description)}</p>
          ${c.assigned_team ? `<p><strong>Team:</strong> ${escapeHtml(c.assigned_team)}</p>` : ''}
          ${leaderDetail}
          ${c.deadline ? `<p><strong>Deadline:</strong> ${escapeHtml(c.deadline)}</p>` : ''}
        </div>
        ${imageHtml}
      </div>
      <div class="complaint-card-actions" style="display:flex; align-items:center; flex-wrap:wrap; gap:8px;">
        <div style="display:flex; align-items:center; gap:4px;">
          <label>Status:</label>
          <select onchange="updateComplaint(${c.id}, this.value, undefined, undefined, undefined)" id="status-${c.id}">
            ${statusOptions}
          </select>
        </div>
        <div style="display:flex; align-items:center; gap:4px;">
          <label>Team:</label>
          <select id="team-${c.id}" onchange="updateWorkerOptions(${c.id}, this.value)" style="width: 140px;">
            ${teamOptions}
          </select>
        </div>
        <div style="display:flex; flex-direction:column; gap:2px;">
          <div style="display:flex; align-items:center; gap:4px;">
            <label>Team Leader:</label>
            <select id="leader-${c.id}" style="width: 140px;" title="All active team members can work on this task, but only the designated leader can submit the final report.">
              <option value="">No leader</option>
              ${workerOptions}
            </select>
          </div>
          <small style="color:#666; font-size:0.75rem;">All team members can work; only leader submits report.</small>
        </div>
        ${legacyTeam}
        <div style="display:flex; align-items:center; gap:4px;">
          <label>Deadline:</label>
          <input type="date" id="deadline-${c.id}" value="${c.deadline || ''}" style="width: 125px;">
        </div>
        <div style="margin-left:auto;">
          <button class="btn btn-primary btn-sm" onclick="saveComplaintAssignment(${c.id}, '${c.status}')">
            <span class="material-icons-round" style="font-size:16px;">save</span> Save
          </button>
          <button class="btn btn-danger btn-sm" onclick="confirmDeleteComplaint(${c.id})" style="margin-left:4px;">
            <span class="material-icons-round" style="font-size:16px;">delete</span> Delete
          </button>
        </div>
      </div>
    </div>
  `;
}

function getWorkerOptionsForTeam(teamId, assignedLeaderId = null) {
  if (!teamId) return '<option value="" disabled>Select a team first</option>';
  
  const validWorkerIds = allTeamMemberships.filter(tm => tm.team_id == teamId).map(tm => tm.worker_id);
  const workers = allWorkers.filter(w => validWorkerIds.includes(w.id));
  
  if (workers.length === 0) return '<option value="" disabled>No workers in this team</option>';
  
  let options = '';
  workers.forEach(w => {
    const isCurrentLeader = (assignedLeaderId != null && String(w.id) === String(assignedLeaderId));
    if (w.is_active || isCurrentLeader) {
      const isSelected = isCurrentLeader ? 'selected' : '';
      const disabledAttr = !w.is_active ? 'disabled' : '';
      const inactiveLabel = !w.is_active ? ' (Inactive)' : '';
      options += `<option value="${w.id}" ${isSelected} ${disabledAttr}>${escapeHtml(w.name)}${inactiveLabel}</option>`;
    }
  });
  return options;
}

function updateWorkerOptions(complaintId, teamId) {
  const select = document.getElementById(`leader-${complaintId}`);
  select.innerHTML = '<option value="">No leader</option>' + getWorkerOptionsForTeam(teamId, null);
}

async function saveComplaintAssignment(id, currentStatus) {
  const teamEl = document.getElementById(`team-${id}`);
  const leaderSelect = document.getElementById(`leader-${id}`);
  
  const team_id = teamEl.value ? parseInt(teamEl.value) : null;
  const leader_id = (leaderSelect && leaderSelect.value) ? parseInt(leaderSelect.value) : null;
  const deadline = document.getElementById(`deadline-${id}`).value;
  
  let status = undefined;
  if (currentStatus === 'Submitted' && team_id) {
    status = 'Assigned';
  }
  
  await updateComplaint(id, status, team_id, undefined, deadline, leader_id);
}

// --- Dashboard: Update Complaint ---
async function updateComplaint(id, status, team_id, worker_ids, deadline, leader_id) {
  const body = {};
  if (status !== undefined) body.status = status;
  if (team_id !== undefined) body.team_id = team_id;
  if (worker_ids !== undefined) body.worker_ids = worker_ids;
  if (deadline !== undefined) body.deadline = deadline;
  if (leader_id !== undefined) body.leader_id = leader_id;

  try {
    const res = await fetch(`${API}/api/admin/complaints/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify(body)
    });

    if (res.status === 401) { adminLogout(); return; }
    const data = await res.json();

    if (!res.ok) throw new Error(data.error);

    showToast('Complaint updated!', 'success');
    loadStats();
    loadComplaints();
  } catch (err) {
    showToast(err.message || 'Failed to update complaint', 'error');
  }
}

// --- Dashboard: Delete Complaint ---
let complaintToDelete = null;

function confirmDeleteComplaint(id) {
  complaintToDelete = id;
  document.getElementById('deleteComplaintModal').style.display = 'flex';
  document.getElementById('deleteError').style.display = 'none';
  document.getElementById('confirmDeleteBtn').onclick = () => deleteComplaint(id);
}

function closeDeleteModal() {
  document.getElementById('deleteComplaintModal').style.display = 'none';
  complaintToDelete = null;
}

async function deleteComplaint(id) {
  const errorDiv = document.getElementById('deleteError');
  const btn = document.getElementById('confirmDeleteBtn');
  btn.disabled = true;
  
  try {
    const res = await fetch(`${API}/api/admin/complaints/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });

    if (res.status === 401) { adminLogout(); return; }
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    closeDeleteModal();
    showToast('Complaint deleted successfully!', 'success');
    loadStats();
    loadComplaints();
  } catch (err) {
    errorDiv.textContent = err.message || 'Failed to delete complaint.';
    errorDiv.style.display = 'block';
  } finally {
    btn.disabled = false;
  }
}

// --- Teams Directory ---
async function fetchTeams() {
  if (!adminToken) return;
  try {
    const res = await fetch(`${API}/api/admin/teams`, { headers: { 'Authorization': `Bearer ${adminToken}` } });
    if (res.ok) allTeams = await res.json();
    const mRes = await fetch(`${API}/api/admin/team-memberships`, { headers: { 'Authorization': `Bearer ${adminToken}` } });
    if (mRes.ok) allTeamMemberships = await mRes.json();
  } catch (err) { console.error(err); }
}

async function showTeamsModal() {
  document.getElementById('teamsModal').style.display = 'flex';
  await fetchTeams();
  renderTeamsList();
}
function closeTeamsModal() {
  document.getElementById('teamsModal').style.display = 'none';
}

function renderTeamsList() {
  const list = document.getElementById('teamsList');
  if (!allTeams.length) { list.innerHTML = '<p style="text-align:center; padding:20px; color:#666;">No teams found.</p>'; return; }
  
  list.innerHTML = allTeams.map(t => `
    <div style="border: 1px solid var(--border-color); padding: 12px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; background: white; margin-bottom: 8px;">
      <div>
        <p style="font-weight: 600; margin-bottom: 4px;">${escapeHtml(t.name)}</p>
        <span class="status-badge ${t.is_active ? 'status-resolved' : 'status-assigned'}">${t.is_active ? 'Active' : 'Inactive'}</span>
      </div>
      <div>
        <button class="btn btn-outline btn-sm" onclick="showTeamMembersModal(${t.id}, '${escapeHtml(t.name.replace(/'/g, "\\'"))}')">Members</button>
        <button class="btn ${t.is_active ? 'btn-danger' : 'btn-primary'} btn-sm" onclick="toggleTeamStatus(${t.id}, ${!t.is_active})" style="margin-left:8px;">
          ${t.is_active ? 'Deactivate' : 'Activate'}
        </button>
      </div>
    </div>
  `).join('');
}

async function createTeam(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const name = document.getElementById('tName').value;
    const res = await fetch(`${API}/api/admin/teams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showToast('Team created successfully!');
    e.target.reset();
    await fetchTeams();
    renderTeamsList();
  } catch (err) {
    showToast(err.message || 'Failed to create team.', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function toggleTeamStatus(id, is_active) {
  try {
    const res = await fetch(`${API}/api/admin/teams/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ is_active })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showToast('Team status updated!');
    await fetchTeams();
    renderTeamsList();
  } catch (err) {
    showToast(err.message || 'Failed to update team status.', 'error');
  }
}

let currentTeamIdForMembers = null;

async function showTeamMembersModal(teamId, teamName) {
  currentTeamIdForMembers = teamId;
  document.getElementById('teamMembersTitle').textContent = `Members: ${teamName}`;
  document.getElementById('teamMembersModal').style.display = 'flex';
  
  await fetchWorkers(); // Ensure we have latest workers for dropdown
  
  const workerSelect = document.getElementById('workerSelect');
  workerSelect.innerHTML = '<option value="" disabled selected>Select an active worker...</option>' + 
    allWorkers.filter(w => w.is_active).map(w => `<option value="${w.id}">${escapeHtml(w.name)} (@${escapeHtml(w.username)})</option>`).join('');
    
  await renderTeamMembersList(teamId);
}
function closeTeamMembersModal() {
  document.getElementById('teamMembersModal').style.display = 'none';
  currentTeamIdForMembers = null;
}

async function renderTeamMembersList(teamId) {
  const list = document.getElementById('teamMembersList');
  list.innerHTML = '<p style="text-align:center; padding:10px;">Loading members...</p>';
  try {
    const res = await fetch(`${API}/api/admin/teams/${teamId}/members`, { headers: { 'Authorization': `Bearer ${adminToken}` } });
    if (!res.ok) throw new Error('Failed to load members');
    const members = await res.json();
    
    if (!members.length) {
      list.innerHTML = '<p style="text-align:center; padding:20px; color:#666;">No members in this team.</p>';
      return;
    }
    
    list.innerHTML = members.map(m => `
      <div style="border: 1px solid var(--border-color); padding: 8px 12px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; background: white; margin-bottom: 8px;">
        <div>
          <p style="font-weight: 600; margin: 0;">${escapeHtml(m.name)} <span style="font-weight: normal; color: #666;">(@${escapeHtml(m.username)})</span></p>
          ${!m.is_active ? '<span class="status-badge status-assigned" style="font-size:10px; margin-top:4px; display:inline-block;">Inactive Worker</span>' : ''}
        </div>
        <button class="btn btn-danger btn-sm" onclick="removeWorkerFromTeam(${teamId}, ${m.id})">Remove</button>
      </div>
    `).join('');
  } catch (err) {
    list.innerHTML = `<p style="color:red; text-align:center;">${err.message}</p>`;
  }
}

async function addWorkerToTeam() {
  const worker_id = document.getElementById('workerSelect').value;
  if (!worker_id) { showToast('Select a worker first.', 'error'); return; }
  
  try {
    const res = await fetch(`${API}/api/admin/teams/${currentTeamIdForMembers}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ worker_id })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showToast('Worker added to team!');
    await renderTeamMembersList(currentTeamIdForMembers);
    document.getElementById('workerSelect').value = '';
  } catch (err) {
    showToast(err.message || 'Failed to add worker.', 'error');
  }
}

async function removeWorkerFromTeam(teamId, workerId) {
  try {
    const res = await fetch(`${API}/api/admin/teams/${teamId}/members/${workerId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    if (!res.ok) throw new Error('Failed to remove worker');
    showToast('Worker removed from team!');
    await renderTeamMembersList(teamId);
  } catch (err) {
    showToast(err.message, 'error');
  }
}


// --- Search Debounce ---
function debounceSearch() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => loadComplaints(), 300);
}

// --- Helpers ---
function getStatusClass(status) {
  const map = {
    'Submitted': 'status-submitted',
    'Under Review': 'status-under-review',
    'Assigned': 'status-assigned',
    'In Progress': 'status-in-progress',
    'Resolved': 'status-resolved'
  };
  return map[status] || '';
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'Z');
  return d.toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showToast(message, type = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// --- Workers Directory ---
async function fetchWorkers() {
  if (!adminToken) return;
  try {
    const res = await fetch(`${API}/api/admin/workers`, { headers: { 'Authorization': `Bearer ${adminToken}` } });
    if (res.ok) allWorkers = await res.json();
  } catch (err) { console.error(err); }
}

function showWorkersModal() {
  document.getElementById('workersModal').style.display = 'flex';
  renderWorkersList();
}
function closeWorkersModal() { 
  document.getElementById('workersModal').style.display = 'none'; 
}

function renderWorkersList() {
  const list = document.getElementById('workersList');
  if (!allWorkers.length) { list.innerHTML = '<p style="text-align:center; padding:20px; color:#666;">No workers found.</p>'; return; }
  list.innerHTML = allWorkers.map(w => `
    <div style="display:flex; justify-content:space-between; align-items:center; padding:12px; border:1px solid #ddd; border-radius:8px;">
      <div>
        <strong>${escapeHtml(w.name)}</strong> (@${escapeHtml(w.username)})<br>
        <small>📞 ${escapeHtml(w.phone)} ${!w.is_active ? '<span style="color:#d32f2f; margin-left:4px;">(Inactive)</span>' : ''}</small>
      </div>
      <button class="btn btn-sm ${w.is_active ? 'btn-outline' : 'btn-primary'}" onclick="toggleWorker(${w.id}, ${!w.is_active})">
        ${w.is_active ? 'Deactivate' : 'Activate'}
      </button>
    </div>
  `).join('');
}

async function createWorker(e) {
  e.preventDefault();
  const name = document.getElementById('wName').value.trim();
  const phone = document.getElementById('wPhone').value.trim();
  const username = document.getElementById('wUsername').value.trim();
  const password = document.getElementById('wPassword').value;
  
  if (!/^\d{10}$/.test(phone)) {
    showToast('Mobile number must be exactly 10 digits.', 'error');
    return;
  }
  
  try {
    const res = await fetch(`${API}/api/admin/workers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ name, phone, username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showToast('Worker created successfully!', 'success');
    e.target.reset();
    await fetchWorkers();
    renderWorkersList();
    loadComplaints(); // refresh dropdowns
  } catch (err) { showToast(err.message, 'error'); }
}

async function toggleWorker(id, isActive) {
  try {
    const res = await fetch(`${API}/api/admin/workers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ is_active: isActive })
    });
    if (!res.ok) throw new Error('Failed to update worker status');
    await fetchWorkers();
    renderWorkersList();
    loadComplaints(); // refresh dropdowns
  } catch (err) { showToast(err.message, 'error'); }
}

// --- Pending Reports ---
let pendingReportsData = [];

async function loadPendingReports() {
  const list = document.getElementById('pendingReportsList');
  const section = document.getElementById('pendingVerificationSection');
  if (!list || !section) return;

  try {
    const res = await fetch(`${API}/api/admin/reports/pending`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) adminLogout();
      return;
    }
    const reports = await res.json();
    pendingReportsData = reports;

    if (reports.length === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';
    list.innerHTML = reports.map(r => `
      <div class="complaint-card" style="border-left: 4px solid #f57c00;">
        <div class="complaint-card-header">
          <div>
            <span class="complaint-card-id">${escapeHtml(r.complaint_ref)}</span>
            <span class="status-badge" style="background:#fff3e0; color:#e65100;">Pending Verification</span>
          </div>
          <span class="complaint-card-date">${formatDate(r.created_at)}</span>
        </div>
        <div class="complaint-card-body">
          <div class="complaint-card-details">
            <p><strong>Category:</strong> ${escapeHtml(r.category || 'Other')}</p>
            <p><strong>Location:</strong> ${escapeHtml(r.location || 'Unknown')}</p>
            <p><strong>Team:</strong> ${escapeHtml(r.team_name || 'None')}</p>
            <p><strong>Assigned:</strong> ${escapeHtml(r.assigned_workers || 'None')}</p>
            <hr style="margin: 8px 0; border: 0; border-top: 1px solid #eee;" />
            <p><strong>Submitted by:</strong> ${escapeHtml(r.worker_name)}</p>
            <p><strong>Notes:</strong> ${escapeHtml(r.notes)}</p>
          </div>
          <div class="complaint-card-image" style="cursor:pointer;" onclick="openVerifyModal(${r.complaint_id})">
             ${r.image_path ? `<img src="${r.image_path.startsWith('http') ? r.image_path : `${API}/${r.image_path}`}" alt="Completion Photo">` : '<div style="padding:40px; background:#f5f5f5; text-align:center; color:#999;"><span class="material-icons-round" style="font-size:32px;">hide_image</span><br>No Photo</div>'}
          </div>
        </div>
        <div style="margin-top: 1rem; border-top: 1px solid #eee; padding-top: 1rem;">
          <button class="btn btn-primary" onclick="openVerifyModal(${r.complaint_id})">
            <span class="material-icons-round">fact_check</span> Verify Report
          </button>
        </div>
      </div>
    `).join('');

  } catch (err) {
    console.error(err);
    list.innerHTML = '<p class="error-text" style="text-align:center;">Failed to load pending reports.</p>';
  }
}

let currentVerifyAction = 'Approve';

function openVerifyModal(complaintId) {
  const report = pendingReportsData.find(r => r.complaint_id === complaintId);
  if (!report) return;
  
  document.getElementById('verifyComplaintId').value = complaintId;
  const details = document.getElementById('verifyReportDetails');
  
  details.innerHTML = `
    <div style="margin-bottom: 1rem;">
      <p style="margin:0;"><strong>Report for ${escapeHtml(report.complaint_ref)}</strong></p>
      <p style="margin:4px 0 0 0; font-size:0.9rem; color:#666;">Submitted by ${escapeHtml(report.worker_name)} at ${formatDate(report.created_at)}</p>
    </div>
    <div style="background:#f9f9f9; padding:12px; border-radius:8px; margin-bottom:1rem;">
      <p style="margin:0;"><strong>Notes:</strong> ${escapeHtml(report.notes)}</p>
    </div>
    <div style="text-align:center; max-height:300px; overflow:hidden; border-radius:8px; background:#000;">
       ${report.image_path ? `<img src="${report.image_path.startsWith('http') ? report.image_path : `${API}/${report.image_path}`}" alt="Completion Photo" style="max-width:100%; max-height:300px; object-fit:contain;">` : '<p style="color:#fff; padding:20px;">No photo attached</p>'}
    </div>
  `;
  
  document.getElementById('rejectionReason').value = '';
  document.getElementById('rejectionReasonGroup').style.display = 'none';
  const btn = document.getElementById('approveBtn');
  btn.textContent = 'Approve Work';
  btn.className = 'btn btn-primary';
  currentVerifyAction = 'Approve';
  
  document.getElementById('verifyReportModal').style.display = 'block';
}

function closeVerifyModal() {
  document.getElementById('verifyReportModal').style.display = 'none';
}

function toggleRejectionReason() {
  const group = document.getElementById('rejectionReasonGroup');
  const btn = document.getElementById('approveBtn');
  
  if (currentVerifyAction === 'Approve') {
    group.style.display = 'block';
    btn.textContent = 'Confirm Rejection';
    btn.className = 'btn btn-danger';
    currentVerifyAction = 'Reject';
  } else {
    group.style.display = 'none';
    btn.textContent = 'Approve Work';
    btn.className = 'btn btn-primary';
    currentVerifyAction = 'Approve';
  }
}

async function submitVerification(e) {
  e.preventDefault();
  
  const complaintId = document.getElementById('verifyComplaintId').value;
  const reason = document.getElementById('rejectionReason').value;
  
  if (currentVerifyAction === 'Reject' && !reason.trim()) {
    showToast('A rejection reason is required.', 'error');
    return;
  }
  
  const btn = document.getElementById('approveBtn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Processing...';
  
  try {
    const res = await fetch(`${API}/api/admin/complaints/${complaintId}/verify`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        action: currentVerifyAction,
        reason: currentVerifyAction === 'Reject' ? reason : undefined
      })
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Verification failed');
    
    showToast(`Work ${currentVerifyAction === 'Approve' ? 'Approved' : 'Rejected'} successfully!`, 'success');
    closeVerifyModal();
    loadPendingReports();
    loadComplaints();
    loadStats();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// --- Init ---
(function init() {
  if (adminToken) {
    const adminLinks = document.querySelectorAll('[data-page="admin-login"]');
    adminLinks.forEach(link => {
      link.textContent = 'Dashboard';
      link.setAttribute('onclick', "navigateTo('dashboard')");
      link.dataset.page = 'dashboard';
    });
    navigateTo('dashboard');
  } else {
    // Load home page
    navigateTo('home');
  }
})();
