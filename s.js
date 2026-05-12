const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.set('trust proxy', 1);

// Connected clients store: uuid -> { socket, cwd, env }
const clients = new Map();
// Viewers store: uuid -> Set of sockets
const viewers = new Map();
// Masters: Set of sockets
const masters = new Set();

const publicDir = path.join(__dirname, 'public-server');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

const indexHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Remote Terminal</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body, html { height: 100%; background: #121212; color: #eee; font-family: 'Courier New', monospace; }
    #terminal { padding: 15px; height: calc(95vh - 40px); overflow-y: auto; white-space: pre-wrap; font-size: 13px; line-height: 1.4; }
    #inputLine { position: fixed; bottom: 0; width: 100%; background: #1a1a1a; padding: 8px 15px; border-top: 1px solid #333; }
    #cmd { width: 100%; background: transparent; border: none; color: #0f0; font-family: 'Courier New', monospace; font-size: 13px; }
    #cmd:focus { outline: none; }
    .output { margin: 2px 0; display: flex; gap: 8px; align-items: flex-start; }
    .error { color: #f55; }
    .system { color: #3af; }
    .command { color: #5f5; }
    .lineCheckbox { margin-top: 2px; cursor: pointer; }
    ::-webkit-scrollbar { width: 8px; }
    ::-webkit-scrollbar-track { background: #1a1a1a; }
    ::-webkit-scrollbar-thumb { background: #444; border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: #666; }
    #controlBar { position: fixed; right: 12px; bottom: 72px; background: #1a1a1a; border: 1px solid #333; padding: 10px; border-radius: 6px; display: flex; flex-direction: column; gap: 6px; z-index: 1000; color: #ddd; font-size: 12px; min-width: 200px; }
    #selectedList { max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; word-break: break-all; }
    button { background: #2a2a2a; color: #eee; border: 1px solid #333; padding: 6px 8px; border-radius: 4px; cursor: pointer; font-family: 'Courier New', monospace; font-size: 11px; }
    button:hover { background: #3a3a3a; }
    .modeToggle { display: flex; gap: 4px; align-items: center; }
    .modeToggle label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
    .modeToggle input[type="radio"] { accent-color: #0f0; cursor: pointer; }
    .modeLabel { font-weight: bold; }
    .mode-none { color: #aaa; }
    .mode-include { color: #5f5; }
    .mode-exclude { color: #f55; }
    .mode-indicator { padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: bold; }
    .mode-indicator.none { background: #aaa2; color: #aaa; border: 1px solid #aaa8; }
    .mode-indicator.include { background: #0f02; color: #5f5; border: 1px solid #0f08; }
    .mode-indicator.exclude { background: #f002; color: #f55; border: 1px solid #f008; }
    .selectedInfo { color: #888; font-size: 10px; }
    .line-highlight { background: #ffffff08; }
  </style>
</head>
<body>
  <div id="terminal"></div>
  <div id="controlBar" title="Selection Controls">
    <div class="modeToggle">
      <span class="modeLabel">Mode:</span>
      <label><input type="radio" name="selMode" value="none" checked /> <span class="mode-none">None</span></label>
      <label><input type="radio" name="selMode" value="include" /> <span class="mode-include">Include</span></label>
      <label><input type="radio" name="selMode" value="exclude" /> <span class="mode-exclude">Exclude</span></label>
      <span id="modeBadge" class="mode-indicator none">NONE</span>
    </div>
    <div id="selectedList" class="selectedInfo">All clients targeted</div>
    <button id="clearBtn">Clear Selections</button>
  </div>
  <div id="inputLine">
    <input type="text" id="cmd" autocomplete="off" spellcheck="false" placeholder="Type command..." autofocus />
  </div>
  <script src="/socket.io/socket.io.js"></script>
  <script>
    let socket = null;
    const terminal = document.getElementById('terminal');
    const input = document.getElementById('cmd');
    const selectedUUIDs = new Set();
    const excludedUUIDs = new Set();
    let selectionMode = 'none'; // 'none', 'include', or 'exclude'
    let commandHistory = [];
    let historyIndex = -1;
    let lastCtrlClickedCheckbox = null;

    // Radio button listeners for mode toggle
    document.querySelectorAll('input[name="selMode"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        if (e.target.checked) {
          selectionMode = e.target.value;
          const badge = document.getElementById('modeBadge');
          badge.textContent = selectionMode.toUpperCase();
          badge.className = 'mode-indicator ' + selectionMode;
          updateSelectedList();

          // Disable checkboxes in 'none' mode, enable otherwise
          document.querySelectorAll('.lineCheckbox').forEach(cb => {
            if (selectionMode === 'none') {
              cb.disabled = true;
            } else {
              cb.disabled = false;
            }
          });
        }
      });
    });

    function updateSelectedList() {
      const el = document.getElementById('selectedList');
      if (selectionMode === 'none') {
        el.textContent = 'Mode: None — all clients targeted via normal input';
      } else if (selectionMode === 'include') {
        if (selectedUUIDs.size === 0) el.textContent = 'Selected (include): none — command will go nowhere';
        else el.textContent = 'Selected (include): ' + Array.from(selectedUUIDs).join(', ');
      } else {
        if (excludedUUIDs.size === 0) el.textContent = 'Excluded: none — all clients targeted';
        else el.textContent = 'Excluded: ' + Array.from(excludedUUIDs).join(', ');
      }
    }

    function getAllVisibleUUIDs() {
      const uuids = new Set();
      document.querySelectorAll('.lineCheckbox:not(:disabled)').forEach(cb => {
        if (cb.dataset.uuid) uuids.add(cb.dataset.uuid);
      });
      return uuids;
    }

    function getTargetUUIDs() {
      if (selectionMode === 'none') {
        // In none mode, return empty set -> broadcast to all
        return null;
      } else if (selectionMode === 'include') {
        return new Set(selectedUUIDs);
      } else {
        const all = getAllVisibleUUIDs();
        excludedUUIDs.forEach(id => all.delete(id));
        return all;
      }
    }

    function makeLineElement(text, cls) {
      const wrapper = document.createElement('div');
      wrapper.className = 'output';
      if (cls) wrapper.classList.add(cls);
      const uuidMatch = text.match(/^\\[([0-9a-fA-F-]{8,36})\\]/);
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'lineCheckbox';
      if (uuidMatch) {
        checkbox.dataset.uuid = uuidMatch[1];
        // Default disabled in 'none' mode
        checkbox.disabled = (selectionMode === 'none');
        checkbox.addEventListener('change', (e) => {
          const id = e.target.dataset.uuid;
          if (selectionMode === 'include') {
            if (e.target.checked) selectedUUIDs.add(id);
            else selectedUUIDs.delete(id);
          } else if (selectionMode === 'exclude') {
            if (e.target.checked) excludedUUIDs.add(id);
            else excludedUUIDs.delete(id);
          }
          updateSelectedList();
        });
        // Ctrl+Click range selection
        checkbox.addEventListener('click', (e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const currentCb = e.target;
            if (lastCtrlClickedCheckbox && lastCtrlClickedCheckbox !== currentCb) {
              const allCheckboxes = Array.from(document.querySelectorAll('.lineCheckbox:not(:disabled)'));
              const startIdx = allCheckboxes.indexOf(lastCtrlClickedCheckbox);
              const endIdx = allCheckboxes.indexOf(currentCb);
              if (startIdx !== -1 && endIdx !== -1) {
                const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
                for (let i = lo; i <= hi; i++) {
                  const cb = allCheckboxes[i];
                  const id = cb.dataset.uuid;
                  if (!id) continue;
                  cb.checked = true;
                  if (selectionMode === 'include') {
                    selectedUUIDs.add(id);
                  } else if (selectionMode === 'exclude') {
                    excludedUUIDs.add(id);
                  }
                }
                updateSelectedList();
              }
            }
            lastCtrlClickedCheckbox = currentCb;
          } else {
            lastCtrlClickedCheckbox = null;
          }
        });
      } else {
        checkbox.disabled = true;
        checkbox.title = 'No UUID on this line';
      }
      const textDiv = document.createElement('div');
      textDiv.textContent = text;
      wrapper.appendChild(checkbox);
      wrapper.appendChild(textDiv);
      return wrapper;
    }

    function appendLine(text, cls) {
      const el = makeLineElement(text, cls);
      terminal.appendChild(el);
      terminal.scrollTop = terminal.scrollHeight;
    }

    socket = io({
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity
    });

    socket.on('connect', () => {
  appendLine('[System] Connected to server', 'system');
  const pathName = window.location.pathname;
  if (pathName === '/master') {
    socket.emit('register-master');
  } else {
    const uuid = (pathName || '/').substring(1);
    if (uuid && uuid !== '') {
      socket.emit('register-viewer', uuid);
    } else {
      // If no UUID provided, register as a new client
      socket.emit('register-client');
    }
  }
});


    socket.on('connect_error', (error) => { appendLine('[System] Connection error: ' + (error.message || 'Unknown error'), 'error'); });
    socket.on('disconnect', (reason) => { appendLine('[System] Disconnected from server: ' + reason, 'error'); });
    socket.on('output', data => { appendLine(data); });
    socket.on('error', data => { appendLine(data, 'error'); });
    socket.on('system', data => { appendLine(data, 'system'); });
    socket.on('command', data => { appendLine('> ' + data, 'command'); });
    socket.on('directory', dir => { document.title = 'Remote Terminal - ' + dir; });
    socket.on('registered', id => { appendLine('[System] Registered with ID: ' + id, 'system'); });

    input.addEventListener('keydown', evt => {
      if (!socket || !socket.connected) return;
      if (evt.key === 'Enter') {
        const val = input.value.trim();
        if (val) {
          const targets = getTargetUUIDs();

          if (targets === null) {
            // None mode: broadcast command to all (normal behavior)
            socket.emit('command', val);
          } else if (targets.size > 0) {
            // Include or exclude mode with targets
            socket.emit('targeted-command', { uuids: Array.from(targets), cmd: val });
            appendLine('[System] Sent targeted command to ' + targets.size + ' client(s): ' + val, 'system');
          } else {
            // Include mode with no selections, or exclude mode with all excluded
            appendLine('[System] No target clients selected — command not sent', 'error');
          }

          commandHistory.push(val);
          historyIndex = commandHistory.length;
        }
        input.value = '';
      } else if (evt.key === 'ArrowUp') {
        evt.preventDefault();
        if (commandHistory.length && historyIndex > 0) {
          historyIndex--;
          input.value = commandHistory[historyIndex];
        }
      } else if (evt.key === 'ArrowDown') {
        evt.preventDefault();
        if (commandHistory.length && historyIndex < commandHistory.length - 1) {
          historyIndex++;
          input.value = commandHistory[historyIndex];
        } else {
          historyIndex = commandHistory.length;
          input.value = '';
        }
      }
    });

    document.getElementById('clearBtn').addEventListener('click', () => {
      selectedUUIDs.clear();
      excludedUUIDs.clear();
      document.querySelectorAll('.lineCheckbox').forEach(cb => { cb.checked = false; });
      lastCtrlClickedCheckbox = null;
      updateSelectedList();
    });

    // Initialize: start in 'none' mode — disable all checkboxes
    document.querySelectorAll('.lineCheckbox').forEach(cb => { cb.disabled = true; });
    updateSelectedList();
  </script>
</body>
</html>`;

fs.writeFileSync(path.join(publicDir, 'index.html'), indexHtml);


app.get('/master', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/:uuid', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Socket.io handling
io.on('connection', (socket) => {
  let role = null;
  let clientId = null;

  socket.on('register-client', (oldId) => {
    role = 'client';
    if (oldId && clients.has(oldId)) {
      clientId = oldId;
      clients.get(clientId).socket = socket;
      console.log(`Client reconnected with existing UUID: ${clientId}`);
      socket.emit('registered', clientId);
    } else {
      clientId = uuidv4();
      clients.set(clientId, {
        socket,
        cwd: process.platform === 'win32' ? process.env.USERPROFILE || process.cwd() : process.cwd(),
        env: {}
      });
      console.log(`Client registered with new UUID: ${clientId}`);
      socket.emit('registered', clientId);
    }

    socket.emit('directory', clients.get(clientId).cwd);

    socket.on('disconnect', () => {
      console.log(`Client ${clientId} disconnected`);
      const conns = viewers.get(clientId);
      if (conns) {
        conns.forEach(s => s.emit('system', '[System] Client disconnected'));
      }
      masters.forEach(ms => ms.emit('system', `[System] Client ${clientId} disconnected`));
    });

    socket.on('output', (data) => {
      const set = viewers.get(clientId);
      if (set) {
        set.forEach(s => s.emit('output', `[${clientId}] ${data}`));
      }
      masters.forEach(ms => ms.emit('output', `[${clientId}] ${data}`));
    });

    socket.on('error', (data) => {
      const set = viewers.get(clientId);
      if (set) {
        set.forEach(s => s.emit('error', `[${clientId}] ${data}`));
      }
      masters.forEach(ms => ms.emit('error', `[${clientId}] ${data}`));
    });

    socket.on('directory', (dir) => {
      const set = viewers.get(clientId);
      if (set) {
        set.forEach(s => s.emit('directory', dir));
      }
      masters.forEach(ms => ms.emit('system', `[${clientId}] Directory changed to: ${dir}`));
    });

    socket.on('run-command', (cmd) => {
      socket.emit('command', cmd);
    });
  });

  socket.on('register-viewer', (id) => {
    role = 'viewer';
    clientId = id;
    if (!clients.has(clientId)) {
      socket.emit('system', '[System] Error: Client not connected or invalid UUID');
      return;
    }

    if (!viewers.has(clientId)) {
      viewers.set(clientId, new Set());
    }
    viewers.get(clientId).add(socket);

    const clientData = clients.get(clientId);
    socket.emit('system', `[System] Connected to client ${clientId}`);
    socket.emit('directory', clientData.cwd);

    socket.on('command', (cmd) => {
      clientData.socket.emit('run-command', cmd);
      socket.emit('command', cmd);
    });

    socket.on('disconnect', () => {
      const set = viewers.get(clientId);
      if (set) {
        set.delete(socket);
        if (set.size === 0) {
          viewers.delete(clientId);
        }
      }
    });
  });

  socket.on('register-master', () => {
    role = 'master';
    masters.add(socket);
    socket.emit('system', `[System] Registered as master terminal`);
    console.log('Master terminal connected');

    socket.on('command', (cmd) => {
      clients.forEach(({ socket: clientSocket }) => {
        clientSocket.emit('run-command', cmd);
      });
      socket.emit('command', cmd);
    });

    socket.on('disconnect', () => {
      masters.delete(socket);
      console.log('Master terminal disconnected');
    });
  });

  // Targeted-command handling
  socket.on('targeted-command', ({ uuids, cmd }) => {
    if (!Array.isArray(uuids) || typeof cmd !== 'string' || cmd.trim() === '') {
      socket.emit('system', '[System] Invalid targeted command payload');
      return;
    }
    uuids.forEach(id => {
      const client = clients.get(id);
      if (client && client.socket && client.socket.connected) {
        client.socket.emit('run-command', cmd);
      } else {
        socket.emit('system', `[System] Client ${id} unavailable or not connected`);
      }
    });
    socket.emit('command', cmd);
  });
});

const PORT = 8080;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
