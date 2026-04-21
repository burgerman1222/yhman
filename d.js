const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

// PASSWORD PROTECTION
const PASSWORD = '{}~[]#L:@l;\'<>?,./';

const app = express();
app.set('trust proxy', 1);

// Apply CORS to Express BEFORE creating server
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  credentials: false
}));

const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: false,
    allowEIO3: true
  },
  pingInterval: 25000,
  pingTimeout: 60000,
  allowUpgrades: true,
  maxHttpBufferSize: 1e6
});

// Middleware for Express routes
const passwordProtection = (req, res, next) => {
  const password = req.query.password || req.headers['x-password'];
  if (password !== PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized: Invalid password' });
  }
  next();
};

// Socket.IO authentication
io.use((socket, next) => {
  const password = socket.handshake.auth.password || 
                   socket.handshake.query.password;
  if (password !== PASSWORD) {
    return next(new Error('Authentication failed: Invalid password'));
  }
  next();
});

// Storage
const clients = new Map();
const viewers = new Map();
const masters = new Set();

const publicDir = path.join(__dirname, 'public-server');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

// HTML with better error handling
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
    
    #authModal { 
      position: fixed; top: 0; left: 0; width: 100%; height: 100%; 
      background: rgba(0,0,0,0.98); display: flex; align-items: center; justify-content: center; 
      z-index: 10000; 
    }
    #authBox { 
      background: #1a1a1a; padding: 40px; border: 2px solid #0ff; border-radius: 5px; 
      text-align: center; min-width: 320px; max-width: 400px; box-shadow: 0 0 20px rgba(0,255,255,0.3);
    }
    #authBox h2 { margin-bottom: 20px; color: #0ff; font-size: 20px; text-transform: uppercase; letter-spacing: 2px; }
    #authBox p { color: #aaa; margin: 12px 0; font-size: 14px; }
    #authBox input { 
      padding: 12px; width: 100%; background: #0a0a0a; border: 1px solid #0ff; 
      color: #0ff; font-family: 'Courier New', monospace; font-size: 14px; 
      margin: 12px 0; transition: all 0.3s;
    }
    #authBox input:focus { outline: none; border-color: #0f0; box-shadow: 0 0 8px #0f0; }
    #authBox button { 
      padding: 12px 30px; background: #0ff; border: none; cursor: pointer; 
      color: #000; font-weight: bold; font-size: 14px; margin-top: 15px; 
      transition: all 0.3s; border-radius: 3px;
    }
    #authBox button:hover { background: #0f0; transform: scale(1.05); }
    #authBox button:active { transform: scale(0.98); }
    #authError { color: #f33; margin-top: 15px; display: none; font-size: 12px; min-height: 18px; }
    #authStatus { color: #3af; margin-top: 15px; display: none; font-size: 12px; min-height: 18px; }
    
    #terminal { padding: 15px; height: 95vh; overflow-y: auto; white-space: pre-wrap; display: none; font-size: 13px; line-height: 1.4; }
    #inputLine { position: fixed; bottom: 0; width: 100%; background: #1a1a1a; padding: 8px 15px; display: none; border-top: 1px solid #333; }
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
  <div id="authModal">
    <div id="authBox">
      <p>Enter your password to continue:</p>
      <input type="password" id="password" placeholder="Enter password" autocomplete="off" />
      <button onclick="authenticate()">Connect</button>
      <div id="authStatus"></div>
      <div id="authError"></div>
    </div>
  </div>
  <div id="terminal"></div>
  <div id="inputLine">
    <input type="text" id="cmd" autocomplete="off" spellcheck="false" placeholder="Type command..." />
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    let socket = null;
    const terminal = document.getElementById('terminal');
    const input = document.getElementById('cmd');
    const authModal = document.getElementById('authModal');
    const authError = document.getElementById('authError');
    const authStatus = document.getElementById('authStatus');
    let commandHistory = [];
    let historyIndex = -1;

    function showStatus(msg) {
      authStatus.textContent = msg;
      authStatus.style.display = 'block';
    }

    function showError(msg) {
      authError.textContent = msg;
      authError.style.display = 'block';
    }

    function clearErrors() {
      authError.style.display = 'none';
      authStatus.style.display = 'none';
    }

    function authenticate() {
      const password = document.getElementById('password').value;
      if (!password) {
        showError('Password required');
        return;
      }

      clearErrors();
      showStatus('Connecting...');

      socket = io({
        auth: { password },
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: 5
      });

      socket.on('connect', () => {
        console.log('Connected:', socket.id);
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
          if (uuid && uuid !== '') {
            socket.emit('register-viewer', uuid);
          }
        }
      });

      socket.on('connect_error', (error) => {
        console.error('Connection error:', error);
        showError('Connection failed: ' + (error.message || 'Unknown error'));
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
    }

    function appendLine(text, cls) {
      const div = document.createElement('div');
      div.textContent = text;
      if (cls) div.classList.add(cls);
      else div.classList.add('output');
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

    document.getElementById('password').addEventListener('keydown', evt => {
      if (evt.key === 'Enter') authenticate();
    });

    // Try to connect on page load
    window.addEventListener('load', () => {
      // Auto-focus password field
      document.getElementById('password').focus();
    });
  </script>
</body>
</html>
`;

fs.writeFileSync(path.join(publicDir, 'index.html'), indexHtml);

// Serve static files
app.use(express.static(publicDir, {
  maxAge: '1h',
  etag: false
}));

// Protected routes
app.get('/master', passwordProtection, (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/:uuid', passwordProtection, (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Socket.IO event handlers
io.on('connection', (socket) => {
  let role = null;
  let clientId = null;

  socket.on('register-client', (oldId) => {
    role = 'client';
    if (oldId && clients.has(oldId)) {
      clientId = oldId;
      clients.get(clientId).socket = socket;
      console.log(`[CLIENT] Reconnected: ${clientId}`);
      socket.emit('registered', clientId);
    } else {
      clientId = uuidv4();
      clients.set(clientId, {
        socket,
        cwd: process.platform === 'win32' ? process.env.USERPROFILE || process.cwd() : process.cwd(),
        env: {}
      });
      console.log(`[CLIENT] Registered: ${clientId}`);
      socket.emit('registered', clientId);
    }

    socket.emit('directory', clients.get(clientId).cwd);

    socket.on('disconnect', (reason) => {
      console.log(`[CLIENT] ${clientId} disconnected: ${reason}`);
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
      masters.forEach(ms => ms.emit('system', `[${clientId}] Directory: ${dir}`));
    });
  });

  socket.on('register-viewer', (id) => {
    role = 'viewer';
    clientId = id;
    if (!clients.has(clientId)) {
      socket.emit('system', `[System] Error: Client ${clientId} not found`);
      return;
    }

    if (!viewers.has(clientId)) {
      viewers.set(clientId, new Set());
    }
    viewers.get(clientId).add(socket);

    const clientData = clients.get(clientId);
    socket.emit('system', `[System] Connected to client ${clientId}`);
    socket.emit('directory', clientData.cwd);
    console.log(`[VIEWER] Connected to ${clientId}`);

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
      console.log(`[VIEWER] Disconnected from ${clientId}`);
    });
  });

  socket.on('register-master', () => {
    role = 'master';
    masters.add(socket);
    socket.emit('system', '[System] Registered as master terminal');
    console.log('[MASTER] Connected');

    socket.on('command', (cmd) => {
      clients.forEach(({ socket }) => {
        socket.emit('run-command', cmd);
      });
      socket.emit('command', cmd);
    });

    socket.on('disconnect', () => {
      masters.delete(socket);
      console.log('[MASTER] Disconnected');
    });
  });

  socket.on('error', (error) => {
    console.error(`[SOCKET ERROR] ${socket.id}:`, error);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════╗
║  Remote Terminal Server Started        ║
║  Port: ${PORT}                         
║  URL: http://0.0.0.0:${PORT}          
╚════════════════════════════════════════╝
  `);
});


process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});


process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});
