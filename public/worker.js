// Worker Portal Logic
let workerToken = localStorage.getItem('workerToken');
let workerName = localStorage.getItem('workerName');

// Override or inject into existing app.js navigation if needed
// app.js handles routing by looking for templates based on data-page or hash.
// If worker-login or worker-dashboard is requested, we intercept if necessary,
// but app.js navigateTo will render the template automatically if the template ID exists.
// We just need to attach initialization logic.

// We can hook into the existing render logic by intercepting DOMContentLoaded or just running our checks
document.addEventListener('DOMContentLoaded', () => {
  // We can patch navigateTo from app.js to handle our dashboard redirect
  const originalNavigateTo = window.navigateTo;
  window.navigateTo = function(page) {
    if (page === 'worker-login' && workerToken) {
      page = 'worker-dashboard';
    }
    originalNavigateTo(page);
    
    if (page === 'worker-dashboard') {
      if (!workerToken) {
        window.navigateTo('worker-login');
        return;
      }
      initWorkerDashboard();
    }
  };

  // Check initial load
  const hash = window.location.hash.substring(1) || 'home';
  if (hash === 'worker-dashboard' && !workerToken) {
    window.navigateTo('worker-login');
  } else if (hash === 'worker-dashboard') {
    initWorkerDashboard();
  } else if (hash === 'worker-login' && workerToken) {
    window.navigateTo('worker-dashboard');
  }
});

async function handleWorkerLogin(e) {
  e.preventDefault();
  const username = document.getElementById('workerUsername').value;
  const password = document.getElementById('workerPassword').value;

  try {
    const res = await fetch(`${API}/api/worker/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    
    const data = await res.json();
    
    if (!res.ok) {
      showToast(data.error || 'Login failed', 'error');
      return;
    }
    
    workerToken = data.token;
    workerName = data.name;
    localStorage.setItem('workerToken', workerToken);
    localStorage.setItem('workerName', workerName);
    
    showToast('Logged in successfully', 'success');
    navigateTo('worker-dashboard');
  } catch (err) {
    showToast('Login failed', 'error');
  }
}

function workerLogout() {
  workerToken = null;
  workerName = null;
  localStorage.removeItem('workerToken');
  localStorage.removeItem('workerName');
  navigateTo('worker-login');
}

function initWorkerDashboard() {
  document.getElementById('workerNameDisplay').textContent = workerName || 'Worker';
  loadWorkerTasks();
}

async function loadWorkerTasks() {
  const listDiv = document.getElementById('workerTasksList');
  if (!listDiv) return;
  
  listDiv.innerHTML = '<p class="loading-text">Loading tasks...</p>';
  
  try {
    const res = await fetch(`${API}/api/worker/tasks`, {
      headers: { 'Authorization': `Bearer ${workerToken}` }
    });
    
    if (res.status === 401 || res.status === 403) {
      showToast('Session expired or access denied', 'error');
      workerLogout();
      return;
    }
    
    const tasks = await res.json();
    
    let personalCount = 0;
    
    if (tasks.length === 0) {
      listDiv.innerHTML = `<div class="empty-state"><span class="material-icons-round">inbox</span><p>No tasks found for your team.</p></div>`;
      document.getElementById('workerTeamCount').textContent = '0';
      document.getElementById('workerPersonalCount').textContent = '0';
      return;
    }
    
    let html = '';
    tasks.forEach(t => {
      if (t.is_personally_assigned) personalCount++;
      html += renderWorkerTaskCard(t);
    });
    
    listDiv.innerHTML = html;
    document.getElementById('workerTeamCount').textContent = tasks.length;
    document.getElementById('workerPersonalCount').textContent = personalCount;
    
  } catch (err) {
    listDiv.innerHTML = `<p style="color:red; text-align:center;">Failed to load tasks.</p>`;
  }
}

function renderWorkerTaskCard(t) {
  let isOverdue = false;
  if (t.deadline && t.status !== 'Resolved') {
    const todayDate = new Date();
    const yyyy = todayDate.getFullYear();
    const mm = String(todayDate.getMonth() + 1).padStart(2, '0');
    const dd = String(todayDate.getDate()).padStart(2, '0');
    const todayLocalStr = `${yyyy}-${mm}-${dd}`;
    if (todayLocalStr > t.deadline) isOverdue = true;
  }
  
  const overdueBadge = isOverdue ? `<span class="status-badge" style="background:#ffebee; color:#d32f2f;">[OVERDUE]</span>` : '';
  const personalBadge = t.is_personally_assigned ? `<span class="status-badge" style="background:#e3f2fd; color:#1976d2;">Assigned to You</span>` : '';
  
  let actionHtml = '';
  if (t.is_personally_assigned) {
    if (t.status === 'Assigned') {
      actionHtml = `
        <div style="margin-top: 1rem; border-top: 1px solid #eee; padding-top: 1rem;">
          <button class="btn btn-primary" onclick="startWork(${t.id})">
            <span class="material-icons-round">play_arrow</span> Start Work
          </button>
        </div>
      `;
    } else if (t.status === 'In Progress') {
      actionHtml = `
        <div style="margin-top: 1rem; border-top: 1px solid #eee; padding-top: 1rem;">
          <button class="btn btn-primary" onclick="openSubmitReportModal(${t.id})">
            <span class="material-icons-round">upload_file</span> Submit Completion Report
          </button>
        </div>
      `;
    }
  }
  
  const rejectionHtml = t.rejection_reason ? `
    <div style="margin-top: 12px; padding: 12px; background: #ffebee; border-radius: 8px; border-left: 4px solid #d32f2f;">
      <p style="color: #d32f2f; margin: 0; font-weight: 500;">
        <span class="material-icons-round" style="font-size: 16px; vertical-align: middle;">error</span> 
        Report Rejected
      </p>
      <p style="margin: 4px 0 0 0; font-size: 0.9rem;">${escapeHtml(t.rejection_reason)}</p>
    </div>
  ` : '';
  
  return `
    <div class="complaint-card" style="${t.is_personally_assigned ? 'border-left: 4px solid var(--primary);' : 'opacity: 0.8;'}">
      <div class="complaint-card-header">
        <div>
          <span class="complaint-card-id">${t.complaint_id}</span>
          <span class="status-badge ${getStatusClass(t.status)}">${t.status}</span>
          ${personalBadge}
          ${overdueBadge}
        </div>
        <span class="complaint-card-date">${formatDate(t.created_at)}</span>
      </div>
      <div class="complaint-card-body">
        <div class="complaint-card-details">
          <p><strong>Category:</strong> ${escapeHtml(t.category || 'Other')}</p>
          <p><strong>Location:</strong> ${escapeHtml(t.location)}</p>
          <p><strong>Description:</strong> ${escapeHtml(t.description)}</p>
          <p><strong>Team:</strong> ${escapeHtml(t.assigned_team || 'Unknown')}</p>
          <p><strong>Workers:</strong> ${escapeHtml(t.responsible_workers || 'None')}</p>
          ${t.deadline ? `<p><strong>Deadline:</strong> ${escapeHtml(t.deadline)}</p>` : ''}
        </div>
      </div>
      ${rejectionHtml}
      ${actionHtml}
    </div>
  `;
}

async function startWork(id) {
  try {
    const res = await fetch(`${API}/api/worker/tasks/${id}/start`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${workerToken}` }
    });
    
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Failed to start work', 'error');
      return;
    }
    
    showToast('Work started successfully', 'success');
    loadWorkerTasks();
  } catch (err) {
    showToast('Failed to start work', 'error');
  }
}

// Report Submission Logic
let reportFile = null;

function openSubmitReportModal(id) {
  document.getElementById('reportComplaintId').value = id;
  document.getElementById('submitReportForm').reset();
  clearReportImage();
  document.getElementById('submitReportModal').style.display = 'block';
}

function closeSubmitReportModal() {
  document.getElementById('submitReportModal').style.display = 'none';
}

function handleReportImageSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showToast('Please select a valid image file.', 'error');
    return;
  }
  
  reportFile = file;
  
  const reader = new FileReader();
  reader.onload = (e) => {
    document.getElementById('reportImagePreview').src = e.target.result;
    document.getElementById('reportImagePreviewContainer').style.display = 'block';
    document.getElementById('reportUploadBox').style.display = 'none';
  };
  reader.readAsDataURL(file);
}

function clearReportImage() {
  reportFile = null;
  document.getElementById('reportImageInput').value = '';
  document.getElementById('reportImagePreview').src = '';
  document.getElementById('reportImagePreviewContainer').style.display = 'none';
  document.getElementById('reportUploadBox').style.display = 'block';
}

async function submitWorkerReport(e) {
  e.preventDefault();
  
  if (!reportFile) {
    showToast('An evidence photo is required.', 'error');
    return;
  }
  
  const btn = document.getElementById('submitReportBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting...';
  
  const complaintId = document.getElementById('reportComplaintId').value;
  const notes = document.getElementById('reportNotes').value;
  
  const formData = new FormData();
  formData.append('notes', notes);
  formData.append('image', reportFile);
  
  try {
    const res = await fetch(`${API}/api/worker/tasks/${complaintId}/report`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${workerToken}` },
      body: formData
    });
    
    const data = await res.json();
    
    if (!res.ok) {
      showToast(data.error || 'Failed to submit report', 'error');
      btn.disabled = false;
      btn.textContent = 'Submit Report';
      return;
    }
    
    showToast('Report submitted successfully!', 'success');
    closeSubmitReportModal();
    loadWorkerTasks();
  } catch (err) {
    console.error(err);
    showToast('Network error while submitting report.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Submit Report';
  }
}
