/* ============================================
   AquaCare — Frontend Application Logic
   ============================================ */

const API = ''; // Same origin — no prefix needed

// --- State ---
let currentPage = 'home';
let adminToken = localStorage.getItem('aquacare_token') || null;
let lastComplaintId = null;
let searchTimeout = null;

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
    if (data.assigned_team) {
      const teamEl = clone.querySelector('.detail-team');
      teamEl.style.display = 'block';
      clone.querySelector('.detail-assigned').textContent = data.assigned_team;
    }

    // Image
    if (data.image_path) {
      const imgContainer = clone.querySelector('.track-image-container');
      imgContainer.style.display = 'block';
      clone.querySelector('.track-image').src = data.image_path;
    }

    // Progress tracker
    const statuses = ['Submitted', 'Under Review', 'Assigned', 'In Progress', 'Resolved'];
    const currentIdx = statuses.indexOf(data.status);
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
    localStorage.setItem('aquacare_token', adminToken);

    // Update nav
    const adminLink = document.querySelector('[data-page="admin-login"]');
    if (adminLink) {
      adminLink.textContent = 'Dashboard';
      adminLink.setAttribute('onclick', "navigateTo('dashboard')");
      adminLink.dataset.page = 'dashboard';
    }

    navigateTo('dashboard');
    showToast('Logged in successfully!', 'success');
  } catch (err) {
    errorDiv.textContent = 'Connection error. Please try again.';
    errorDiv.style.display = 'block';
  }
}

function adminLogout() {
  adminToken = null;
  localStorage.removeItem('aquacare_token');

  // Reset nav
  const adminLink = document.querySelector('[data-page="dashboard"]');
  if (adminLink) {
    adminLink.textContent = 'Admin';
    adminLink.setAttribute('onclick', "navigateTo('admin-login')");
    adminLink.dataset.page = 'admin-login';
  }

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

  return `
    <div class="complaint-card" id="card-${c.id}">
      <div class="complaint-card-header">
        <div>
          <span class="complaint-card-id">${c.complaint_id}</span>
          <span class="status-badge ${getStatusClass(c.status)}">${c.status}</span>
        </div>
        <span class="complaint-card-date">${formatDate(c.created_at)}</span>
      </div>
      <div class="complaint-card-body">
        <div class="complaint-card-details">
          <p><strong>Name:</strong> ${escapeHtml(c.name)}</p>
          <p><strong>Phone:</strong> ${escapeHtml(c.phone)}</p>
          <p><strong>Location:</strong> ${escapeHtml(c.location)}</p>
          <p><strong>Description:</strong> ${escapeHtml(c.description)}</p>
          ${c.assigned_team ? `<p><strong>Team:</strong> ${escapeHtml(c.assigned_team)}</p>` : ''}
        </div>
        ${imageHtml}
      </div>
      <div class="complaint-card-actions">
        <label>Status:</label>
        <select onchange="updateComplaint(${c.id}, this.value, null)" id="status-${c.id}">
          ${statusOptions}
        </select>
        <label>Team:</label>
        <input type="text" placeholder="Assign team..." value="${c.assigned_team || ''}" id="team-${c.id}" style="width: 160px;">
        <button class="btn btn-primary btn-sm" onclick="updateComplaint(${c.id}, null, document.getElementById('team-${c.id}').value)">
          <span class="material-icons-round" style="font-size:16px;">save</span> Save
        </button>
        <button class="btn btn-danger btn-sm" onclick="confirmDeleteComplaint(${c.id})" style="margin-left:auto;">
          <span class="material-icons-round" style="font-size:16px;">delete</span> Delete
        </button>
      </div>
    </div>
  `;
}

// --- Dashboard: Update Complaint ---
async function updateComplaint(id, status, team) {
  const body = {};
  if (status) body.status = status;
  if (team !== null) body.assigned_team = team;

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

// --- Init ---
(function init() {
  // If admin token exists, update nav link
  if (adminToken) {
    const adminLink = document.querySelector('[data-page="admin-login"]');
    if (adminLink) {
      adminLink.textContent = 'Dashboard';
      adminLink.setAttribute('onclick', "navigateTo('dashboard')");
      adminLink.dataset.page = 'dashboard';
    }
  }

  // Load home page
  navigateTo('home');
})();
