/* ===== Video & Audio Frontend — app.js ===== */

function uiIcon(name, className = '') {
    return `<svg class="ui-icon ${className}" aria-hidden="true"><use href="/static/ui-icons.svg#${name}"></use></svg>`;
}

// ===== SocketIO Client =====
if (typeof io !== 'undefined') {
    window._socket = io();
    window._socket.on('connect', () => console.log('SocketIO connected'));
    window._socket.on('job_update', (data) => {
        if (data && data.status === 'completed' && Notification.permission === 'granted') {
            new Notification('Video & Audio', { body: `Job "${data.title || data.job_id}" completed!` });
        }
    });
}

// ===== Theme Toggle =====
function toggleTheme() {
    const html = document.documentElement;
    const current = html.dataset.theme || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    html.dataset.theme = next;
    localStorage.setItem('avidae-theme', next);
    const btn = document.getElementById('themeToggle');
    if (btn) btn.innerHTML = uiIcon(next === 'dark' ? 'sun' : 'moon');
}

// Apply saved theme on load
(function() {
    const saved = localStorage.getItem('avidae-theme');
    if (saved) {
        document.documentElement.dataset.theme = saved;
    }
    const btn = document.getElementById('themeToggle');
    const theme = document.documentElement.dataset.theme || 'dark';
    if (btn) btn.innerHTML = uiIcon(theme === 'dark' ? 'sun' : 'moon');
})();

// ===== Browser Notifications =====
function requestNotifications() {
    if (!('Notification' in window)) {
        showToast('Notifications not supported', 'error');
        return;
    }
    Notification.requestPermission().then(perm => {
        showToast(perm === 'granted' ? 'Notifications enabled!' : 'Notifications denied');
    });
}

// ===== Video Modal =====
function closeVideoModal() {
    const modal = document.getElementById('videoModal');
    const player = document.getElementById('videoPlayer');
    if (modal) modal.classList.remove('active');
    if (player) { player.pause(); player.src = ''; }
}

// ===== Utility Functions =====

function escHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function statusBadge(status) {
    const cls = `badge badge-${status}`;
    const labels = {
        'queued': 'Queued',
        'analyzing': 'Analyzing',
        'recording': 'Recording',
        'post-processing': 'Processing',
        'completed': 'Completed',
        'failed': 'Failed',
        'cancelled': 'Cancelled',
    };
    return `<span class="${cls}">${labels[status] || status}</span>`;
}

function progressBar(pct) {
    pct = pct || 0;
    let cls = '';
    if (pct >= 100) cls = 'pf-completed';
    else if (pct > 10) cls = 'pf-recording';
    return `
        <div class="progress-bar">
            <div class="progress-fill ${cls}" style="width:${pct}%"></div>
        </div>
        <div class="progress-text">${pct}%</div>
    `;
}

function timeAgo(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    const now = new Date();
    const diff = Math.floor((now - d) / 1000);

    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
}

function updateActiveJobCount(jobs) {
    const active = (jobs || []).filter(j =>
        ['queued', 'analyzing', 'recording', 'post-processing'].includes(j.status)
    ).length;
    const el = document.getElementById('activeJobCount');
    if (el) {
        el.textContent = active + ' active';
        if (active > 0) {
            el.classList.add('has-active');
        } else {
            el.classList.remove('has-active');
        }
    }
}

// ===== Toast Notifications =====

function showToast(message, type = 'info') {
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type === 'error' ? 'toast-error' : ''}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        toast.style.transition = 'all 0.3s';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ===== Log Modal =====

async function showLogs(jobId) {
    const modal = document.getElementById('logModal');
    const output = document.getElementById('logOutput');
    modal.classList.add('active');
    output.textContent = 'Loading logs...';

    try {
        const resp = await fetch(`/api/jobs/${jobId}/logs`);
        const data = await resp.json();
        output.textContent = data.logs || '(No logs yet)';
        output.scrollTop = output.scrollHeight;
    } catch (e) {
        output.textContent = 'Failed to load logs.';
    }

    // Auto-refresh logs while modal is open
    if (window._logInterval) clearInterval(window._logInterval);
    window._logInterval = setInterval(async () => {
        if (!modal.classList.contains('active')) {
            clearInterval(window._logInterval);
            return;
        }
        try {
            const resp = await fetch(`/api/jobs/${jobId}/logs`);
            const data = await resp.json();
            output.textContent = data.logs || '(No logs yet)';
            output.scrollTop = output.scrollHeight;
        } catch (e) { /* silent */ }
    }, 3000);
}

function closeLogModal() {
    const modal = document.getElementById('logModal');
    modal.classList.remove('active');
    if (window._logInterval) clearInterval(window._logInterval);
}

// Close modal on overlay click
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) {
        closeLogModal();
        closeVideoModal();
    }
});

// Close modal on Escape + Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeLogModal();
        closeVideoModal();
    }

    // Don't fire shortcuts when typing in inputs
    const tag = document.activeElement?.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const routes = {
        'd': '/',
        'r': '/record',
        'w': '/download',
        'c': '/convert',
        't': '/video-trim',
        'm': '/video-merge',
        'p': '/video-compress',
        'e': '/extract-audio',
        'a': '/audio-convert',
        'g': '/audio-record',
        'h': '/audio-trim',
        'j': '/jobs',
        's': '/settings'
    };

    const route = routes[e.key.toLowerCase()];
    if (route && window.location.pathname !== route) {
        window.location.href = route;
    }
});

// ===== Job Actions =====

async function cancelJob(jobId) {
    if (!confirm('Cancel this job?')) return;
    try {
        const resp = await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
        const data = await resp.json();
        if (data.ok) {
            showToast('Job cancelled');
        } else {
            showToast('Could not cancel: ' + (data.error || ''), 'error');
        }
    } catch (e) {
        showToast('Network error', 'error');
    }
}

async function deleteJob(jobId) {
    if (!confirm('Permanently delete this job and all its files?')) return;
    try {
        const resp = await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
        const data = await resp.json();
        if (data.ok) {
            showToast('Job deleted');
            // Refresh page data
            if (typeof loadJobs === 'function') loadJobs();
            if (typeof loadDashboard === 'function') loadDashboard();
        } else {
            showToast('Delete failed: ' + (data.error || ''), 'error');
        }
    } catch (e) {
        showToast('Network error', 'error');
    }
}
