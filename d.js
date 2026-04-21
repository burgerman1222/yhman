const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket'],
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// PASSWORD PROTECTION
const PASSWORD = '{}~[]#L:@l;\'<>?,./';

// Middleware to protect HTTP routes
const passwordProtection = (req, res, next) => {
  const password = req.query.password || req.headers['x-password'];
  if (password !== PASSWORD) {
    return res.status(401).send('Unauthorized: Invalid password');
  }
  next();
};

// Socket.io authentication middleware
io.use((socket, next) => {
  const password = socket.handshake.auth.password || 
                   socket.handshake.query.password;
  if (password !== PASSWORD) {
    return next(new Error('Authentication failed: Invalid password'));
  }
  next();
});

// Connected clients store: uuid -> { socket, cwd, env }
const clients = new Map();
const viewers = new Map();
const masters = new Set();

const publicDir = path.join(__dirname, 'public-server');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

// Updated HTML with password prompt
const indexHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>Remote Terminal</title>
  <style>
    body, html { height: 100%; margin:0; background: #121212; color: #eee; font-family: monospace; }
    #terminal { padding: 10px; height: 95vh; overflow-y: auto; white-space: pre-wrap; display: none; }
    #inputLine { position: fixed; bottom: 0; width: 100%; background: #212121; padding: 5px; display: none; }
    #cmd { width: 98%; background: transparent; border: none; color: #eee; font-family: monospace; font-size: 16px; }
    #cmd:focus { outline: none; }
    .output { margin: 2px 0; }
    .error { color: #f33; }
    .system { color: #3af; }
    .command { color: #afa; }
    #authModal { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.95); display: flex; align-items: center; justify-content: center; z-index: 10000; }
    #authBox { background: #1a1a1a; padding: 40px; border: 2px solid #0ff; border-radius: 5px; text-align: center; min-width: 350px; }
    #authBox h2 { margin-top: 0; color: #0ff; font-size: 20px; }
    #authBox p { color: #aaa; margin: 15px 0; }
    #authBox input { padding: 12px; width: 100%; box-sizing: border-box; background: #0a0a0a; border: 1px solid #0ff; color: #0ff; font-family: monospace; font-size: 14px; margin: 15px 0; }
    #authBox input:focus { outline: none; border-color: #0f0; box-shadow: 0 0 5px #0f0; }
    #authBox button { padding: 12px 30px; background: #0ff; border: none; cursor: pointer; color: #000; font-weight: bold; font-size: 14px; margin-top: 10px; }
    #authBox button:hover { background: #0f0; }
    #authError { color: #f33; margin-top: 15px; display: none; font-size: 12px; }
  </style>
</head>
<body>
  <div id="authModal">
    <div id="authBox">
      <p>Enter password to continue:</p>
      <input type="password" id="password" placeholder="Password" autofocus />
      <button onclick="authenticate()">Connect</button>
      <div id="authError"></div>
    </div>
  </div>
  <div id="terminal"></div>
  <div id="inputLine">
    <input type="text" id="cmd" autocomplete="off" spellcheck="false" />
  </div>
<script src="/socket.io/socket.io.js"></script>
<script>
  let socket = null;
  const terminal = document.getElementById('terminal');
  const input = document.getElementById('cmd');
  const authModal = document.getElementById('authModal');
  const authError = document.getElementById('authError');
  let commandHistory = [];
  let historyIndex = -1;

  function authenticate() {
    const password = document.getElementById('password').value;
    if (!password) {
      authError.textContent = 'Password required';
      authError.style.display = 'block';
      return;
    }

    authError.style.display = 'none';

    // Connect with password
    socket = io({
      auth: { password }
    });

    socket.on('connect', () => {
      authModal.style.display = 'none';
      terminal.style.display = 'block';
      document.getElementById('inputLine').style.display = 'block';
      input.focus();
      appendLine('[System] Connected to server', 'system');
      
      const pathName = window.location.pathname;
      if (pathName === '/master') {
        socket.emit('register-master');
      } else {
        const uuid = (pathName || '/').substring(1);
        if (uuid) {
          socket.emit('register-viewer', uuid);
        }
      }
    });

    socket.on('connect_error', (error) => {
      authError.textContent = 'Authentication failed: ' + error.message;
      authError.style.display = 'block';
      socket = null;
    });

    socket.on('output', data => {
      appendLine(data);
    });
    socket.on('error', data => {
      appendLine(data, 'error');
    });
    socket.on('system', data => {
      appendLine(data, 'system');
    });
    socket.on('command', data => {
      appendLine('> ' + data, 'command');
    });
    socket.on('directory', dir => {
      document.title = 'Remote Terminal - ' + dir;
    });
  }

  function appendLine(text, cls) {
    const div = document.createElement('div');
    div.textContent = text;
    if (cls) div.classList.add(cls);
    terminal.appendChild(div);
    terminal.scrollTop = terminal.scrollHeight;
  }

  input.addEventListener('keydown', evt => {
    if (!socket || !socket.connected) return;
    
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

  document.getElementById('password').addEventListener('keydown', evt => {
    if (evt.key === 'Enter') authenticate();
  });
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(publicDir, 'index.html'), indexHtml);

app.use(express.static(publicDir));

// Protected routes
app.get('/master', passwordProtection, (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/:uuid', passwordProtection, (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Socket.io handling (rest of your code remains the same)
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
