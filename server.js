const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = 3001;

// { userId: { socketId, name, partnerId, location, approved } }
const users = {};

// { inviteId: { from, to, status: 'pending'|'accepted'|'rejected' } }
const invites = {};

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'VibratePing running', users: Object.keys(users) });
});

let serverUrl = '';
app.get('/api/server-url', (req, res) => res.json({ url: serverUrl }));
app.post('/api/server-url', (req, res) => {
  serverUrl = req.body.url;
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  socket.on('register', (data) => {
    const { userId, name, partnerId } = data;

    if (!userId || !name) {
      socket.emit('error', 'userId and name required');
      return;
    }

    // Kalau reconnect, update socketId-nya aja
    users[userId] = {
      socketId: socket.id,
      name,
      partnerId: partnerId || null,
      location: null,
    };
    socket.userId = userId;

    console.log(`[✓] Registered: ${userId} (${name})`);
    socket.emit('registered', { userId, message: 'Connected' });

    // Kasih tau user ini apakah partnernya sudah online
    if (partnerId && users[partnerId]) {
      // Kasih tau diri sendiri bahwa partner online
      socket.emit('partner_status', {
        online: true,
        name: users[partnerId].name,
        userId: partnerId,
      });

      // Kasih tau partner bahwa user ini online
      io.to(users[partnerId].socketId).emit('partner_status', {
        online: true,
        name,
        userId,
      });
    }
  });

  // === INVITE SYSTEM ===

  // A kirim invite ke B
  socket.on('send_invite', ({ from, to }) => {
    if (!from || !to) return socket.emit('error', 'Invalid invite data');

    const target = users[to];
    if (!target) {
      socket.emit('invite_result', { success: false, message: `User ${to} tidak ditemukan atau belum online` });
      return;
    }

    const inviteId = `${from}-${to}-${Date.now()}`;
    invites[inviteId] = { from, to, status: 'pending' };

    // Kirim notif invite ke target
    io.to(target.socketId).emit('incoming_invite', {
      inviteId,
      from,
      fromName: users[from]?.name || from,
    });

    socket.emit('invite_sent', { inviteId, to });
    console.log(`[→] Invite: ${from} → ${to} (${inviteId})`);
  });

  // B respond invite
  socket.on('respond_invite', ({ inviteId, accept }) => {
    const invite = invites[inviteId];
    if (!invite) {
      socket.emit('error', 'Invite tidak ditemukan');
      return;
    }

    invite.status = accept ? 'accepted' : 'rejected';

    const senderUser = users[invite.from];
    const responderUser = users[invite.to];

    if (accept) {
      // Update partnerId kedua user
      if (users[invite.from]) users[invite.from].partnerId = invite.to;
      if (users[invite.to]) users[invite.to].partnerId = invite.from;

      // Kasih tau sender bahwa invite diterima
      if (senderUser) {
        io.to(senderUser.socketId).emit('invite_accepted', {
          by: invite.to,
          byName: responderUser?.name || invite.to,
        });

        // Langsung kasih tau sender bahwa partner online
        io.to(senderUser.socketId).emit('partner_status', {
          online: true,
          name: responderUser?.name || invite.to,
          userId: invite.to,
        });
      }

      // Kasih tau responder juga
      socket.emit('partner_status', {
        online: true,
        name: senderUser?.name || invite.from,
        userId: invite.from,
      });

      console.log(`[✓] Invite accepted: ${invite.from} ↔ ${invite.to}`);
    } else {
      if (senderUser) {
        io.to(senderUser.socketId).emit('invite_rejected', {
          by: invite.to,
          byName: responderUser?.name || invite.to,
        });
      }
      console.log(`[✗] Invite rejected: ${invite.from} ✗ ${invite.to}`);
    }

    // Cleanup invite setelah direspon
    delete invites[inviteId];
  });

  // Ping
  socket.on('ping', (data) => {
    const { from, to } = data;
    if (!from || !to) return socket.emit('error', 'Invalid ping data');

    const target = users[to];
    if (!target) return socket.emit('error', `User ${to} not connected`);

    io.to(target.socketId).emit('ping', {
      from,
      fromName: users[from]?.name || from,
      timestamp: new Date().toISOString(),
    });

    console.log(`[>>>] Ping: ${from} → ${to}`);
  });

  // Location update
  socket.on('location_update', (data) => {
    const { userId, lat, lng } = data;

    if (!userId || lat == null || lng == null) return;
    if (!users[userId]) return;

    users[userId].location = { lat, lng, timestamp: new Date().toISOString() };

    // Forward ke partner spesifik (bukan broadcast ke semua)
    const partnerId = users[userId].partnerId;
    if (partnerId && users[partnerId]) {
      io.to(users[partnerId].socketId).emit('location_update', {
        from: userId,
        lat,
        lng,
        timestamp: users[userId].location.timestamp,
      });
    }
  });

  socket.on('disconnect', () => {
    const userId = socket.userId;
    if (!userId || !users[userId]) return;

    const partnerId = users[userId].partnerId;
    delete users[userId];

    // Kasih tau partner spesifik, bukan broadcast
    if (partnerId && users[partnerId]) {
      io.to(users[partnerId].socketId).emit('partner_status', {
        online: false,
        userId,
      });
    }

    console.log(`[-] Disconnected: ${userId}`);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[VibratePing] Running on :${PORT}`);
});