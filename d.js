const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Connected clients store: uuid -> { ws, cwd, env }
const clients = new Map();

// Viewers store: uuid -> Set of websockets
const viewers = new Map();

// Masters: Set of websockets (can be multiple)
const masters = new Set();

const publicDir = path.join(__dirname, 'public-server');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

// Serve terminal UI file
const indexHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>Remote Terminal</title>
  <style>
    body, html { height: 100%; margin:0; background: #121212; color: #eee; font-family: monospace; }
    
    #loginContainer {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: #121212;
      display: flex;
      justify-content: center;
      align-items: center;
      z-index: 1000;
    }
    
    #loginContainer.hidden { display: none; }
    
    .loginBox {
      background: #1e1e1e;
      border: 2px solid #3af;
      padding: 30px;
      border-radius: 5px;
      text-align: center;
      min-width: 300px;
    }
    
    .loginBox h1 { margin-top: 0; color: #3af; }
    
    .loginBox input {
      width: 100%;
      padding: 10px;
      margin: 15px 0;
      background: #2a2a2a;
      border: 1px solid #3af;
      color: #eee;
      font-family: monospace;
      font-size: 14px;
      box-sizing: border-box;
    }
    
    .loginBox input:focus { outline: none; border-color: #5df; }
    
    .loginBox button {
      width: 100%;
      padding: 10px;
      background: #3af;
      color: #000;
      border: none;
      font-family: monospace;
      font-weight: bold;
      cursor: pointer;
      border-radius: 3px;
    }
    
    .loginBox button:hover { background: #5df; }
    
    .loginError { color: #f33; margin: 10px 0; font-size: 12px; }
    
    #terminal { padding: 10px; height: 95vh; overflow-y: auto; white-space: pre-wrap; }
    #inputLine { position: fixed; bottom: 0; width: 100%; background: #212121; padding: 5px; }
    #cmd { width: 98%; background: transparent; border: none; color: #eee; font-family: monospace; font-size: 16px; }
    #cmd:focus { outline: none; }
    .output { margin: 2px 0; }
    .error { color: #f33; }
    .system { color: #3af; }
    .command { color: #afa; }
  </style>
</head>
<body>
  <div id="loginContainer">
    <div class="loginBox">
      <p>Enter password to continue</p>
      <input type="password" id="passwordInput" placeholder="Password" autocomplete="off" spellcheck="false" />
      <button onclick="submitPassword()">Login</button>
      <div id="loginError" class="loginError"></div>
    </div>
  </div>
  
  <div id="terminal"></div>
  <div id="inputLine">
    <input type="text" id="cmd" autofocus autocomplete="off" spellcheck="false" />
  </div>

<script>
  const terminal = document.getElementById('terminal');
  const input = document.getElementById('cmd');
  const loginContainer = document.getElementById('loginContainer');
  const passwordInput = document.getElementById('passwordInput');
  const loginError = document.getElementById('loginError');

  let commandHistory = [];
  let historyIndex = -1;
  let isAuthenticated = false;
  let ws = null;

  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(protocol + '//' + window.location.host);

    ws.onopen = () => {
      console.log('WebSocket connected');
      if (!isAuthenticated) {
        passwordInput.focus();
      }
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      appendLine('[System] Connection error. Retrying...', 'error');
      setTimeout(() => connectWebSocket(), 3000);
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      if (isAuthenticated) {
        appendLine('[System] Connection lost. Reconnecting...', 'error');
        setTimeout(() => connectWebSocket(), 3000);
      }
    };
  }

  function handleMessage(msg) {
    const { type, data } = msg;

    switch (type) {
      case 'password-verified':
        isAuthenticated = true;
        loginContainer.classList.add('hidden');
        input.focus();
        appendLine('[System] Connected to server', 'system');
        break;
      case 'password-invalid':
        passwordInput.value = '';
        loginError.textContent = 'Invalid password';
        passwordInput.focus();
        break;
      case 'output':
        if (isAuthenticated) appendLine(data, 'output');
        break;
      case 'error':
        if (isAuthenticated) appendLine(data, 'error');
        break;
      case 'system':
        if (isAuthenticated) appendLine(data, 'system');
        break;
      case 'command':
        if (isAuthenticated) appendLine('> ' + data, 'command');
        break;
      case 'directory':
        if (isAuthenticated) document.title = 'Remote Terminal - ' + data;
        break;
      case 'registered':
        if (isAuthenticated) appendLine('[System] Registered with ID: ' + data, 'system');
        break;
    }
  }

  function appendLine(text, cls) {
    const div = document.createElement('div');
    div.textContent = text;
    if (cls) div.classList.add(cls);
    terminal.appendChild(div);
    terminal.scrollTop = terminal.scrollHeight;
  }

  function sendMessage(type, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, data }));
    }
  }

  window.submitPassword = function() {
    const password = passwordInput.value;
    sendMessage('verify-password', password);
  };

  passwordInput.addEventListener('keydown', evt => {
    if (evt.key === 'Enter') {
      window.submitPassword();
    }
  });

  input.addEventListener('keydown', evt => {
    if (!isAuthenticated) return;
    if (evt.key === 'Enter') {
      const val = input.value.trim();
      if (val) {
        sendMessage('command', val);
        commandHistory.push(val);
        historyIndex = commandHistory.length;
      }
      input.value = '';
    } else if (evt.key === 'ArrowUp') {
      if (commandHistory.length && historyIndex > 0) {
        historyIndex--;
        input.value = commandHistory[historyIndex];
      }
      evt.preventDefault();
    } else if (evt.key === 'ArrowDown') {
      if (commandHistory.length && historyIndex < commandHistory.length - 1) {
        historyIndex++;
        input.value = commandHistory[historyIndex];
      } else {
        historyIndex = commandHistory.length;
        input.value = '';
      }
      evt.preventDefault();
    }
  });

  // Determine role from URL path
  const pathName = window.location.pathname;
  connectWebSocket();

  ws = new WebSocket((window.location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + window.location.host);
  ws.onopen = () => {
    if (pathName === '/master') {
      sendMessage('register-master', null);
    } else {
      const uuid = (pathName || '/').substring(1);
      if (uuid && uuid !== '') {
        sendMessage('register-viewer', uuid);
      }
    }
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleMessage(msg);
  };
  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    appendLine('[System] Connection error', 'error');
  };
  ws.onclose = () => {
    console.log('WebSocket closed');
    if (isAuthenticated) {
      appendLine('[System] Connection lost', 'error');
    }
  };
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(publicDir, 'index.html'), indexHtml);

app.use(express.static(publicDir));

// Routes
app.get('/master', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/:uuid', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// WebSocket handling
wss.on('connection', (ws) => {
  let role = null;
  let clientId = null;
  let isAuthenticated = false;

  ws.on('message', (messageStr) => {
    try {
      const { type, data } = JSON.parse(messageStr);

      // Password verification
      if (type === 'verify-password') {
        const correctPassword = 'e8e30cda-2782-4671-873c-42bea099a233';
        if (data === correctPassword) {
          isAuthenticated = true;
          ws.send(JSON.stringify({ type: 'password-verified' }));
        } else {
          ws.send(JSON.stringify({ type: 'password-invalid' }));
        }
        return;
      }

      if (!isAuthenticated) {
        ws.send(JSON.stringify({ type: 'system', data: '[System] Please authenticate first' }));
        return;
      }

      // Register client
      if (type === 'register-client') {
        role = 'client';
        const oldId = data;
        if (oldId && clients.has(oldId)) {
          clientId = oldId;
          clients.get(clientId).ws = ws;
          console.log(`Client reconnected with existing UUID: ${clientId}`);
          ws.send(JSON.stringify({ type: 'registered', data: clientId }));
        } else {
          clientId = uuidv4();
          clients.set(clientId, {
            ws,
            cwd: process.platform === 'win32' ? process.env.USERPROFILE || process.cwd() : process.cwd(),
            env: {}
          });
          console.log(`Client registered with new UUID: ${clientId}`);
          ws.send(JSON.stringify({ type: 'registered', data: clientId }));
        }

        const clientData = clients.get(clientId);
        ws.send(JSON.stringify({ type: 'directory', data: clientData.cwd }));

        ws.on('close', () => {
          console.log(`Client ${clientId} disconnected`);
          const conns = viewers.get(clientId);
          if (conns) {
            conns.forEach(s => s.send(JSON.stringify({ type: 'system', data: '[System] Client disconnected' })));
          }
          masters.forEach(ms => ms.send(JSON.stringify({ type: 'system', data: `[System] Client ${clientId} disconnected` })));
          clients.delete(clientId);
        });

        return;
      }

      // Register viewer
      if (type === 'register-viewer') {
        role = 'viewer';
        clientId = data;
        if (!clients.has(clientId)) {
          ws.send(JSON.stringify({ type: 'system', data: '[System] Error: Client not connected or invalid UUID' }));
          return;
        }

        if (!viewers.has(clientId)) {
          viewers.set(clientId, new Set());
        }
        viewers.get(clientId).add(ws);

        const clientData = clients.get(clientId);
        ws.send(JSON.stringify({ type: 'system', data: `[System] Connected to client ${clientId}` }));
        ws.send(JSON.stringify({ type: 'directory', data: clientData.cwd }));

        ws.on('close', () => {
          const set = viewers.get(clientId);
          if (set) {
            set.delete(ws);
            if (set.size === 0) {
              viewers.delete(clientId);
            }
          }
        });

        return;
      }

      // Register master
      if (type === 'register-master') {
        role = 'master';
        masters.add(ws);
        ws.send(JSON.stringify({ type: 'system', data: '[System] Registered as master terminal' }));
        console.log('Master terminal connected');

        ws.on('close', () => {
          masters.delete(ws);
          console.log('Master terminal disconnected');
        });

        return;
      }

      // Handle commands
      if (type === 'command') {
        if (role === 'master') {
          clients.forEach(({ ws: clientWs }) => {
            clientWs.send(JSON.stringify({ type: 'run-command', data }));
          });
          ws.send(JSON.stringify({ type: 'command', data }));
        } else if (role === 'viewer') {
          const clientData = clients.get(clientId);
          if (clientData) {
            clientData.ws.send(JSON.stringify({ type: 'run-command', data }));
            ws.send(JSON.stringify({ type: 'command', data }));
          }
        }
        return;
      }

      // Handle output/error/directory from client
      if (type === 'output' || type === 'error' || type === 'directory') {
        if (role === 'client') {
          const set = viewers.get(clientId);
          if (set) {
            set.forEach(s => s.send(JSON.stringify({ type, data: `[${clientId}] ${data}` })));
          }
          masters.forEach(ms => ms.send(JSON.stringify({ type, data: `[${clientId}] ${data}` })));
        }
      }

    } catch (error) {
      console.error('Message handling error:', error);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
