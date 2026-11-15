/* ========================================
   CORPUS ULTIMATE — AI Chat page
   ======================================== */

window.chat = (function () {
  let currentConversation = null;
  let conversations = [];
  let isGenerating = false;
  let abortController = null;
  let ws = null;

  async function render() {
    const user = state.getUser();
    const container = window.CORPUS_APP.getPageContainer();
    if (!container) return;
    if (!user) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-user-circle"></i><h3>Sign in required</h3><p>Please sign in to chat with your model.</p></div>';
      return;
    }

    const activeModel = state.getActiveModel();
    container.innerHTML = `
      <div class="chat-header">
        <div style="display:flex; align-items:center; gap:var(--space-2);">
          <h3 style="margin:0; font-size:var(--text-title-medium); color:var(--color-text);">AI Chat</h3>
          ${activeModel ? '<span style="font-size:var(--text-label-small); background:var(--color-surface-elevated); padding:var(--space-1) var(--space-2); border-radius:var(--radius-md); color:var(--color-primary); font-weight:600;">Model: ' + escapeHtml(activeModel.name || 'Unnamed') + '</span>' : '<span style="font-size:var(--text-label-small); color:var(--color-error);">No model selected</span>'}
        </div>
      </div>

      <div class="chat-container">
        <div class="chat-sidebar">
          <div class="chat-header" style="padding:var(--space-3); border-bottom:none;">
            <h3 style="font-size:var(--text-title-medium); margin:0; color:var(--color-text);">Conversations</h3>
          </div>
          <div class="chat-list" id="chat-list">
            <!-- conversations -->
          </div>
        </div>
        <div class="chat-main">
          <div class="chat-messages" id="chat-messages">
            <div class="empty-state" style="padding:var(--space-6);">
              <i class="fas fa-comments"></i>
              <h3 style="margin-bottom:var(--space-2); color:var(--color-text);">Start a conversation</h3>
              <p style="color:var(--color-text-variant);">Select a model and send your first message. CORPUS will generate a real response from its trained weights.</p>
            </div>
          </div>
          <div class="chat-settings" id="chat-settings">
            <div class="chat-setting-row">
              <span class="chat-setting-label">Temperature</span>
              <input type="range" id="chat-temp" min="0" max="2" step="0.1" value="0.8" class="slider">
              <span class="chat-setting-value" id="chat-temp-val">0.8</span>
            </div>
            <div class="chat-setting-row">
              <span class="chat-setting-label">Top-K</span>
              <input type="number" id="chat-topk" value="50" min="1" style="width:80px;">
            </div>
            <div class="chat-setting-row">
              <span class="chat-setting-label">Top-P</span>
              <input type="range" id="chat-topp" min="0" max="1" step="0.05" value="0.9" class="slider">
              <span class="chat-setting-value" id="chat-topp-val">0.9</span>
            </div>
            <div class="chat-setting-row">
              <span class="chat-setting-label">Max tokens</span>
              <input type="number" id="chat-maxtokens" value="100" min="1" style="width:80px;">
            </div>
          </div>
          <div class="chat-input-area">
            <textarea id="chat-input" placeholder="Type your message..."></textarea>
            <button class="chat-send" id="chat-send" onclick="chat.sendMessage()" disabled title="Send">
              <i class="fas fa-paper-plane"></i>
            </button>
          </div>
        </div>
      </div>
    `;

    // Wire settings
    document.getElementById('chat-temp')?.addEventListener('input', (e) => {
      document.getElementById('chat-temp-val').textContent = e.target.value;
    });
    document.getElementById('chat-topp')?.addEventListener('input', (e) => {
      document.getElementById('chat-topp-val').textContent = e.target.value;
    });
    document.getElementById('chat-input')?.addEventListener('input', (e) => {
      document.getElementById('chat-send').disabled = !e.target.value.trim() || isGenerating;
    });
    document.getElementById('chat-input')?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        chat.sendMessage();
      }
    });

    await loadConversations();
  }

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  async function loadConversations() {
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.listEvaluations(token);
      conversations = data || [];
    } catch (err) {
      conversations = [];
    }
    renderConversationList();
  }

  function renderConversationList() {
    const container = document.getElementById('chat-list');
    if (conversations.length === 0) {
      container.innerHTML = '<div style="padding:var(--space-3); color:var(--color-text-variant); font-size:var(--text-body-small);">No conversations yet.</div>';
      return;
    }
    container.innerHTML = conversations.map((c, i) => `
      <div class="chat-list-item ${currentConversation === c.id ? 'active' : ''}" onclick="chat.openConversation('${c.id}', '${escapeHtml(c.title || 'Conversation')}')">
        <div class="chat-avatar">C</div>
        <div style="flex:1; min-width:0;">
          <div style="font-weight:600; font-size:var(--text-body-small); color:var(--color-text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(c.title || 'Conversation')}</div>
          <div style="font-size:var(--text-label-small); color:var(--color-text-variant); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${CORPUS_UTILS.formatDate(c.created_at || c.updated_at)}</div>
        </div>
      </div>
    `).join('');
  }

  function openConversation(id, title) {
    currentConversation = id;
    renderConversationList();
    const messages = document.getElementById('chat-messages');
    messages.innerHTML = '<div class="empty-state" style="padding:var(--space-6);"><i class="fas fa-comments"></i><h3 style="margin-bottom:var(--space-2); color:var(--color-text);">' + escapeHtml(title) + '</h3><p style="color:var(--color-text-variant);">No messages yet. Send a message to start.</p></div>';
  }

  async function sendMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text || isGenerating) return;

    const activeModel = state.getActiveModel();
    if (!activeModel) {
      ui.toast('Please select a model first', 'error');
      return;
    }

    // Add user message
    const messages = document.getElementById('chat-messages');
    messages.innerHTML = '';
    addMessage(text, 'user');
    input.value = '';
    document.getElementById('chat-send').disabled = true;

    isGenerating = true;
    abortController = new AbortController();

    // Add AI message placeholder
    const aiMsg = document.createElement('div');
    aiMsg.className = 'chat-message ai';
    aiMsg.innerHTML = '<div class="chat-message-content" id="chat-ai-content"><i class="fas fa-circle-notch fa-spin"></i> Generating...</div><div class="chat-message-time" id="chat-ai-time"></div>';
    messages.appendChild(aiMsg);
    messages.scrollTop = messages.scrollHeight;

    try {
      const payload = {
        text,
        temperature: parseFloat(document.getElementById('chat-temp').value) || 0.8,
        top_k: parseInt(document.getElementById('chat-topk').value) || 50,
        top_p: parseFloat(document.getElementById('chat-topp').value) || 0.9,
        max_tokens: parseInt(document.getElementById('chat-maxtokens').value) || 100,
      };
      const token = await state.getAccessToken();
      const result = await window.CORPUS_API.infer(activeModel.id, payload, token);
      const response = result.response || result.text || 'No response generated.';
      document.getElementById('chat-ai-content').textContent = response;
      document.getElementById('chat-ai-time').textContent = new Date().toLocaleTimeString();
      ui.toast('Response generated', 'success');
    } catch (err) {
      document.getElementById('chat-ai-content').textContent = 'Error: ' + (err.message || 'Generation failed');
      document.getElementById('chat-ai-content').style.color = 'var(--color-error)';
      ui.toast(err.message || 'Generation failed', 'error');
    } finally {
      isGenerating = false;
      abortController = null;
      document.getElementById('chat-send').disabled = false;
      messages.scrollTop = messages.scrollHeight;
    }
  }

  function addMessage(text, role) {
    const messages = document.getElementById('chat-messages');
    const div = document.createElement('div');
    div.className = 'chat-message ' + role;
    div.innerHTML = '<div class="chat-message-content">' + escapeHtml(text) + '</div><div class="chat-message-time">' + new Date().toLocaleTimeString() + '</div>';
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  return { render, sendMessage, openConversation };
})();