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
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.set('trust proxy', 1);

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
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Remote Terminal</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body, html { height: 100%; background: #121212; color: #eee; font-family: 'Courier New', monospace; }
    
    #terminal { 
      padding: 15px; height: 95vh; overflow-y: auto; white-space: pre-wrap; 
      font-size: 13px; line-height: 1.4; 
    }
    #inputLine { 
      position: fixed; bottom: 0; width: 100%; background: #1a1a1a; 
      padding: 8px 15px; border-top: 1px solid #333; 
    }
    #cmd { 
      width: 100%; background: transparent; border: none; color: #0f0; 
      font-family: 'Courier New', monospace; font-size: 13px;
    }
    #cmd:focus { outline: none; }
    .output { margin: 2px 0; }
    .error { color: #f55; }
    .system { color: #3af; }
    .command { color: #5f5; }
    
    /* Scrollbar styling */
    ::-webkit-scrollbar { width: 8px; }
    ::-webkit-scrollbar-track { background: #1a1a1a; }
    ::-webkit-scrollbar-thumb { background: #444; border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: #666; }
  </style>
</head>
<body>
  <div id="terminal"></div>
  <div id="inputLine">
    <input type="text" id="cmd" autocomplete="off" spellcheck="false" placeholder="Type command..." autofocus />
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    let socket = null;
    const terminal = document.getElementById('terminal');
    const input = document.getElementById('cmd');
    let commandHistory = [];
    let historyIndex = -1;

    function appendLine(text, cls) {
      const div = document.createElement('div');
      div.textContent = text;
      if (cls) div.classList.add(cls);
      else div.classList.add('output');
      terminal.appendChild(div);
      terminal.scrollTop = terminal.scrollHeight;
    }

    socket = io({
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity
    });

    socket.on('connect', () => {
      console.log('Connected:', socket.id);
      appendLine('[System] Connected to server', 'system');
      
      const pathName = window.location.pathname;
      if (pathName === '/master') {
        socket.emit('register-master');
      } else {
        const uuid = (pathName || '/').substring(1);
        if (uuid && uuid !== '') {
          socket.emit('register-viewer', uuid);
        }
      }
    });

    socket.on('connect_error', (error) => {
      console.error('Connection error:', error);
      appendLine('[System] Connection error: ' + (error.message || 'Unknown error'), 'error');
    });

    socket.on('disconnect', (reason) => {
      console.log('Disconnected:', reason);
      appendLine('[System] Disconnected from server: ' + reason, 'error');
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
    socket.on('registered', id => {
      appendLine('[System] Registered with ID: ' + id, 'system');
    });

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
  </script>
</body>
</html>
`;

fs.writeFileSync(path.join(publicDir, 'index.html'), indexHtml);

app.use(express.static(publicDir));

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
