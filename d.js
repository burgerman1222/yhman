const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Connected clients store: uuid -> { socket, cwd, env }
const clients = new Map();

// Viewers store: uuid -> Set of sockets
const viewers = new Map();

// Masters: Set of sockets (can be multiple)
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

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  const terminal = document.getElementById('terminal');
  const input = document.getElementById('cmd');
  const loginContainer = document.getElementById('loginContainer');
  const passwordInput = document.getElementById('passwordInput');
  const loginError = document.getElementById('loginError');

  let commandHistory = [];
  let historyIndex = -1;
  let isAuthenticated = false;

  function appendLine(text, cls) {
    const div = document.createElement('div');
    div.textContent = text;
    if (cls) div.classList.add(cls);
    terminal.appendChild(div);
    terminal.scrollTop = terminal.scrollHeight;
  }

  window.submitPassword = function() {
    const password = passwordInput.value;
    socket.emit('verify-password', password);
  };

  passwordInput.addEventListener('keydown', evt => {
    if (evt.key === 'Enter') {
      window.submitPassword();
    }
  });

  socket.on('password-verified', () => {
    isAuthenticated = true;
    loginContainer.classList.add('hidden');
    input.focus();
    appendLine('[System] Connected to server', 'system');
  });

  socket.on('password-invalid', () => {
    passwordInput.value = '';
    loginError.textContent = 'Invalid password';
    passwordInput.focus();
  });

  socket.on('connect', () => {
    if (!isAuthenticated) {
      passwordInput.focus();
    }
  });

  socket.on('output', data => {
    if (isAuthenticated) appendLine(data);
  });
  socket.on('error', data => {
    if (isAuthenticated) appendLine(data, 'error');
  });
  socket.on('system', data => {
    if (isAuthenticated) appendLine(data, 'system');
  });
  socket.on('command', data => {
    if (isAuthenticated) appendLine('> ' + data, 'command');
  });
  socket.on('directory', dir => {
    if (isAuthenticated) document.title = 'Remote Terminal - ' + dir;
  });

  input.addEventListener('keydown', evt => {
    if (!isAuthenticated) return;
    if (evt.key === 'Enter') {
      const val = input.value.trim();
      if (val) {
        socket.emit('command', val);
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

  const pathName = window.location.pathname;
  if (pathName === '/master') {
    socket.emit('register-master');
  } else {
    const uuid = (pathName || '/').substring(1);
    if (uuid) {
      socket.emit('register-viewer', uuid);
    }
  }
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(publicDir, 'index.html'), indexHtml);

app.use(express.static(publicDir));

// Routes:
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
  let isAuthenticated = false;

  // Password verification
  socket.on('verify-password', (password) => {
    const correctPassword = 'e8e30cda-2782-4671-873c-42bea099a233';
    if (password === correctPassword) {
      isAuthenticated = true;
      socket.emit('password-verified');
    } else {
      socket.emit('password-invalid');
    }
  });

  socket.on('register-client', (oldId) => {
    if (!isAuthenticated) {
      socket.emit('system', '[System] Please authenticate first');
      return;
    }

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

    socket.on('output', data => {
      const set = viewers.get(clientId);
      if (set) {
        set.forEach(s => s.emit('output', `[${clientId}] ${data}`));
      }
      masters.forEach(ms => ms.emit('output', `[${clientId}] ${data}`));
    });

    socket.on('error', data => {
      const set = viewers.get(clientId);
      if (set) {
        set.forEach(s => s.emit('error', `[${clientId}] ${data}`));
      }
      masters.forEach(ms => ms.emit('error', `[${clientId}] ${data}`));
    });

    socket.on('directory', dir => {
      const set = viewers.get(clientId);
      if (set) {
        set.forEach(s => s.emit('directory', dir));
      }
      masters.forEach(ms => ms.emit('system', `[${clientId}] Directory changed to: ${dir}`));
    });

    socket.on('run-command', (cmd) => {
      // Just forward run-command events to client
    });
  });

  socket.on('register-viewer', (id) => {
    if (!isAuthenticated) {
      socket.emit('system', '[System] Please authenticate first');
      return;
    }

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
    if (!isAuthenticated) {
      socket.emit('system', '[System] Please authenticate first');
      return;
    }

    role = 'master';
    masters.add(socket);
    socket.emit('system', `[System] Registered as master terminal`);
    console.log('Master terminal connected');

    socket.on('command', (cmd) => {
      clients.forEach(({ socket }) => {
        socket.emit('run-command', cmd);
      });
      socket.emit('command', cmd);
    });

    socket.on('disconnect', () => {
      masters.delete(socket);
      console.log('Master terminal disconnected');
    });
  });
});

const PORT = 8080;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
