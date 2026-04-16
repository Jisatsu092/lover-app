const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = 3001; // Beda dari cat feeder

// { userId: { socketId, location: { lat, lng, timestamp } } }
const users = {};

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'VibratePing running', users: Object.keys(users) });
});

// Biar Expo app tau URL server (sama kayak pattern cat feeder lo)
let serverUrl = '';
app.get('/api/server-url', (req, res) => res.json({ url: serverUrl }));
app.post('/api/server-url', (req, res) => {
  serverUrl = req.body.url;
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // Register user
  socket.on('register', (data) => {
    const userId = typeof data === 'string' ? data : data.userId;

    if (!userId) {
      socket.emit('error', 'userId required');
      return;
    }

    users[userId] = { socketId: socket.id, location: null };
    socket.userId = userId;

    console.log(`[✓] Registered: ${userId}`);
    socket.emit('registered', { userId, message: 'Connected' });

    // Kasih tau partner kalau user ini online
    broadcastToPartner(userId, 'partner_status', { online: true });
  });

  // Ping handler (unchanged logic)
  socket.on('ping', (data) => {
    const { from, to } = data;
    if (!from || !to) return socket.emit('error', 'Invalid ping data');

    const target = users[to];
    if (!target) return socket.emit('error', `User ${to} not connected`);

    io.to(target.socketId).emit('ping', {
      from,
      message: `Ping from ${from}`,
      timestamp: new Date().toISOString()
    });

    console.log(`[>>>] Ping: ${from} → ${to}`);
  });

  // Location update — ini yang baru
  socket.on('location_update', (data) => {
    const { userId, lat, lng } = data;

    if (!userId || lat == null || lng == null) {
      socket.emit('error', 'Invalid location data');
      return;
    }

    if (!users[userId]) {
      socket.emit('error', 'User not registered');
      return;
    }

    // Simpan lokasi terbaru
    users[userId].location = { lat, lng, timestamp: new Date().toISOString() };

    // Forward ke partner
    broadcastToPartner(userId, 'location_update', {
      from: userId,
      lat,
      lng,
      timestamp: users[userId].location.timestamp
    });
  });

  // Request lokasi partner secara eksplisit
  socket.on('get_location', (data) => {
    const { from, to } = data;
    const target = users[to];

    if (!target) {
      socket.emit('location_response', { error: `${to} not connected` });
      return;
    }

    if (!target.location) {
      socket.emit('location_response', { error: `${to} belum kirim lokasi` });
      return;
    }

    socket.emit('location_response', {
      from: to,
      ...target.location
    });
  });

  socket.on('disconnect', () => {
    const userId = socket.userId;
    if (userId && users[userId]) {
      delete users[userId];
      broadcastToPartner(userId, 'partner_status', { online: false });
      console.log(`[-] Disconnected: ${userId}`);
    }
  });
});

// Helper: kirim ke semua user SELAIN pengirim
// Untuk 2 user, ini otomatis kirim ke partner
const broadcastToPartner = (senderUserId, event, data) => {
  Object.entries(users).forEach(([uid, user]) => {
    if (uid !== senderUserId) {
      io.to(user.socketId).emit(event, data);
    }
  });
};

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[VibratePing] Running on :${PORT}`);
});