// server/server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');

// ============================================================================
// FIREBASE INIT
// ============================================================================
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

const PORT = process.env.PORT || 3001;

const EXPO_EXPERIENCE_ID = '@yourUsername/RaDelfi';
const EXPO_SCOPE_KEY = '@yourUsername/RaDelfi';

// ============================================================================
// IN-MEMORY STORE
// ============================================================================
const users = {};
const invites = {};

app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'RaDelfi API Running',
    users: Object.keys(users).length,
    invites: Object.keys(invites).length,
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/server-url', (req, res) => res.json({ url: serverUrl || `http://localhost:${PORT}` }));
let serverUrl = '';
app.post('/api/server-url', (req, res) => {
  serverUrl = req.body.url;
  console.log(`[API] Server URL updated: ${serverUrl}`);
  res.json({ ok: true });
});

// ============================================================================
// FCM TOKEN REGISTRATION
// ============================================================================
app.post('/api/register-token', async (req, res) => {
  const { userId, fcmToken, platform = 'android' } = req.body;

  if (!userId || !fcmToken) {
    return res.status(400).json({ ok: false, error: 'userId and fcmToken required' });
  }

  try {
    if (users[userId]) {
      users[userId].fcmToken = fcmToken;
      users[userId].platform = platform;
    } else {
      users[userId] = {
        socketId: null,
        name: null,
        partnerId: null,
        location: null,
        fcmToken,
        platform,
        lastSeen: Date.now(),
      };
    }

    console.log(`[FCM] Token registered: ${userId} (${platform})`);
    res.json({ ok: true, message: 'Token registered' });

  } catch (error) {
    console.error(`[FCM] Registration error for ${userId}:`, error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// PING FALLBACK — dipanggil pingHelper saat socket disconnect
// ============================================================================
app.post('/api/ping-fallback', async (req, res) => {
  const { from, fromName, to, customMessage } = req.body;

  if (!from || !to) {
    return res.status(400).json({ success: false, error: 'from and to are required' });
  }

  const target = users[to];
  if (!target) {
    return res.status(404).json({ success: false, error: `User ${to} not found` });
  }

  if (!target.fcmToken) {
    return res.status(404).json({ success: false, error: `${to} has no FCM token registered` });
  }

  // ✅ Ganti key 'from' -> 'senderId' (reserved key di FCM)
  const pingPayload = {
    senderId: from,               // <-- perubahan
    fromName: fromName || from,
    type: 'ping',
    timestamp: Date.now().toString(),
    ...(customMessage && { customMessage }),
  };

  const result = await sendFCM(
    target.fcmToken,
    '💛 Rasa Masuk',
    `${fromName || from} lagi kangen kamu${customMessage ? `: ${customMessage}` : ''}`,
    pingPayload,
    'high'
  );

  if (result.success) {
    console.log(`[PING-FALLBACK] ${from} → ${to} (via FCM HTTP)`);
    res.json({ success: true, messageId: result.messageId, method: 'fcm' });
  } else {
    console.error(`[PING-FALLBACK] Failed: ${result.error}`);
    res.status(500).json({ success: false, error: result.error });
  }
});

// ============================================================================
// FCM SENDER
// ============================================================================
const sendFCM = async (fcmToken, title, body, data = {}, priority = 'high') => {
  try {
    const message = {
      token: fcmToken,
      notification: { title, body },
      data: {
        ...data,
        experienceId: EXPO_EXPERIENCE_ID,
        scopeKey: EXPO_SCOPE_KEY,
        timestamp: Date.now().toString(),
      },
      android: {
        priority,
        ttl: 3600,
        notification: {
          channelId: data.type === 'ping' ? 'radelfi-ping' : 'radelfi-default',
          sound: 'default',
        },
      },
      apns: {
        payload: {
          aps: {
            alert: { title, body },
            sound: 'default',
            contentAvailable: true,
            mutableContent: true,
          },
        },
        headers: {
          'apns-priority': priority === 'high' ? '10' : '5',
        },
      },
    };

    const response = await admin.messaging().send(message);
    console.log(`[FCM] ✓ Sent: ${response}`);
    return { success: true, messageId: response };

  } catch (error) {
    console.error(`[FCM] ✗ Error:`, error.message);

    if (
      error.code === 'messaging/invalid-registration-token' ||
      error.code === 'messaging/registration-token-not-registered'
    ) {
      for (const [userId, userData] of Object.entries(users)) {
        if (userData.fcmToken === fcmToken) {
          console.log(`[FCM] 🗑️ Removing invalid token for: ${userId}`);
          users[userId].fcmToken = null;
          break;
        }
      }
    }

    return { success: false, error: error.message, code: error.code };
  }
};

// ============================================================================
// SOCKET.IO HANDLERS
// ============================================================================
io.on('connection', (socket) => {
  console.log(`[SOCKET] + Connected: ${socket.id} from ${socket.handshake.address}`);

  // REGISTER USER
  socket.on('register', (data) => {
    const { userId, name, partnerId, fcmToken, platform = 'android' } = data;

    if (!userId || !name) {
      socket.emit('error', 'userId and name are required');
      return;
    }

    const existingToken = users[userId]?.fcmToken;
    const existingPartnerId = users[userId]?.partnerId;

    users[userId] = {
      socketId: socket.id,
      name,
      partnerId: partnerId || existingPartnerId || null,
      location: null,
      fcmToken: fcmToken || existingToken || null,
      platform,
      lastSeen: Date.now(),
    };

    socket.userId = userId;
    console.log(`[SOCKET] ✓ Registered: ${userId} as "${name}" (partner: ${partnerId || 'none'})`);

    socket.emit('registered', {
      userId,
      message: 'Connected successfully',
      timestamp: Date.now(),
    });

    if (partnerId && users[partnerId]) {
      const partnerData = users[partnerId];
      if (partnerData.socketId && io.sockets.sockets.get(partnerData.socketId)) {
        io.to(partnerData.socketId).emit('partner_status', {
          online: true,
          name,
          userId,
          timestamp: Date.now(),
        });
      }
    }
  });

  // INVITE SYSTEM
  socket.on('send_invite', ({ from, to }) => {
    if (!from || !to) {
      socket.emit('invite_result', { success: false, message: 'Invalid invite data' });
      return;
    }

    const target = users[to];
    if (!target) {
      socket.emit('invite_result', { success: false, message: `User ${to} not found` });
      return;
    }

    const inviteId = `${from}-${to}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    invites[inviteId] = { from, to, status: 'pending', createdAt: Date.now() };

    const fromName = users[from]?.name || from;
    // ✅ Ganti key 'from' -> 'senderId' untuk payload FCM
    const invitePayload = { inviteId, senderId: from, fromName, type: 'invite' };

    if (target.socketId && io.sockets.sockets.get(target.socketId)) {
      io.to(target.socketId).emit('incoming_invite', invitePayload);
      console.log(`[INVITE] ${from} → ${to} (via socket)`);
    } else if (target.fcmToken) {
      sendFCM(
        target.fcmToken,
        '💌 Undangan Masuk',
        `${fromName} mengundang kamu jadi partner`,
        invitePayload,
        'high'
      ).then((result) => {
        if (!result.success) {
          socket.emit('invite_result', {
            success: false,
            message: 'Failed to send invite (FCM error)',
            fcmError: result.error,
          });
        }
      });
      console.log(`[INVITE] ${from} → ${to} (via FCM)`);
    } else {
      socket.emit('invite_result', {
        success: false,
        message: `${to} is offline and has no FCM token registered`,
      });
      console.log(`[INVITE] ${from} → ${to} (FAILED: no token)`);
      return;
    }

    socket.emit('invite_sent', { inviteId, to, timestamp: Date.now() });
  });

  socket.on('respond_invite', ({ inviteId, accept }) => {
    const invite = invites[inviteId];
    if (!invite) {
      socket.emit('error', 'Invite not found or expired');
      return;
    }

    invite.status = accept ? 'accepted' : 'rejected';
    invite.respondedAt = Date.now();

    const sender = users[invite.from];
    const responder = users[invite.to];
    const responderName = responder?.name || invite.to;

    if (accept) {
      if (sender) sender.partnerId = invite.to;
      if (responder) responder.partnerId = invite.from;

      if (sender?.socketId && io.sockets.sockets.get(sender.socketId)) {
        io.to(sender.socketId).emit('invite_accepted', {
          by: invite.to,
          byName: responderName,
          timestamp: Date.now(),
        });
        io.to(sender.socketId).emit('partner_status', {
          online: true,
          name: responderName,
          userId: invite.to,
        });
      } else if (sender?.fcmToken) {
        // Payload ini tidak mengandung key 'from', aman
        sendFCM(
          sender.fcmToken,
          '✅ Undangan Diterima',
          `${responderName} menerima undangan kamu!`,
          { type: 'invite_accepted', by: invite.to, byName: responderName },
          'normal'
        );
      }

      socket.emit('partner_status', {
        online: sender?.socketId ? true : false,
        name: sender?.name || invite.from,
        userId: invite.from,
      });

      console.log(`[INVITE] ✓ Accepted: ${invite.from} ↔ ${invite.to}`);
    } else {
      if (sender?.socketId && io.sockets.sockets.get(sender.socketId)) {
        io.to(sender.socketId).emit('invite_rejected', {
          by: invite.to,
          byName: responderName,
          timestamp: Date.now(),
        });
      }
      console.log(`[INVITE] ✗ Rejected: ${invite.from} ✗ ${invite.to}`);
    }

    delete invites[inviteId];
  });

  // PING SYSTEM
  socket.on('ping', (data) => {
    const { from, to, customMessage } = data;

    if (!from || !to) {
      socket.emit('error', 'Invalid ping data: from and to required');
      return;
    }

    const target = users[to];
    if (!target) {
      socket.emit('error', `User ${to} not found`);
      return;
    }

    const fromName = users[from]?.name || from;
    // ✅ Ganti key 'from' -> 'senderId' untuk payload FCM
    const pingPayload = {
      senderId: from,             // <-- perubahan
      fromName,
      type: 'ping',
      timestamp: Date.now().toString(),
      ...(customMessage && { customMessage }),
    };

    if (target.socketId && io.sockets.sockets.get(target.socketId)) {
      // Untuk socket, kita tetap kirimkan dengan key 'from' agar client tidak perlu banyak perubahan
      // Tapi karena socket event 'ping' ini hanya untuk komunikasi realtime, biarkan saja.
      // Namun payload yang dikirim ke client via socket bisa pakai 'from' karena bukan FCM.
      // Tapi konsisten lebih baik pakai 'from' untuk socket, 'senderId' untuk FCM.
      // Kita kirim via socket tetap dengan struktur asli { from, fromName, type, ... }
      io.to(target.socketId).emit('ping', {
        from,
        fromName,
        type: 'ping',
        timestamp: Date.now().toString(),
        via: 'socket',
        ...(customMessage && { customMessage }),
      });
      console.log(`[PING] ${from} → ${to} (via socket)`);
    } else if (target.fcmToken) {
      sendFCM(
        target.fcmToken,
        '💛 Rasa Masuk',
        `${fromName} lagi kangen kamu${customMessage ? `: ${customMessage}` : ''}`,
        pingPayload,   // payload dengan senderId, aman
        'high'
      ).then((result) => {
        if (!result.success) {
          socket.emit('error', `Failed to send ping via FCM: ${result.error}`);
        }
      });
      console.log(`[PING] ${from} → ${to} (via FCM)`);
    } else {
      socket.emit('error', `${to} is offline and no FCM token registered`);
      console.log(`[PING] ${from} → ${to} (FAILED: no token)`);
    }
  });

  // LOCATION SHARING
  socket.on('location_update', (data) => {
    const { userId, lat, lng, accuracy, timestamp: clientTimestamp } = data;

    if (!userId || lat == null || lng == null) {
      console.warn(`[LOCATION] Invalid data from socket ${socket.id}`);
      return;
    }

    const userData = users[userId];
    if (!userData) {
      console.warn(`[LOCATION] User ${userId} not registered`);
      return;
    }

    userData.location = {
      lat,
      lng,
      accuracy: accuracy || null,
      timestamp: clientTimestamp || new Date().toISOString(),
      receivedAt: Date.now(),
    };

    const partnerId = userData.partnerId;
    if (partnerId && users[partnerId]?.socketId) {
      const partnerSocket = users[partnerId].socketId;
      if (io.sockets.sockets.get(partnerSocket)) {
        io.to(partnerSocket).emit('location_update', {
          from: userId,
          fromName: userData.name,
          lat,
          lng,
          accuracy: accuracy || null,
          timestamp: userData.location.timestamp,
        });
      }
    }
  });

  // DISCONNECT
  socket.on('disconnect', (reason) => {
    const userId = socket.userId;
    if (!userId || !users[userId]) {
      console.log(`[SOCKET] - Disconnected unknown: ${socket.id} (${reason})`);
      return;
    }

    const userData = users[userId];
    const partnerId = userData.partnerId;

    users[userId].socketId = null;
    users[userId].lastSeen = Date.now();
    users[userId].status = 'offline';

    console.log(`[SOCKET] - Disconnected: ${userId} (${reason}) | Token: ${userData.fcmToken ? 'kept' : 'none'}`);

    if (partnerId && users[partnerId]?.socketId) {
      const partnerSocket = users[partnerId].socketId;
      if (io.sockets.sockets.get(partnerSocket)) {
        io.to(partnerSocket).emit('partner_status', {
          online: false,
          userId,
          lastSeen: users[userId].lastSeen,
          reason,
        });
      }
    }
  });

  socket.on('error', (error) => {
    console.error(`[SOCKET] Error on ${socket.userId || socket.id}:`, error);
  });
});

// ============================================================================
// CLEANUP EXPIRED INVITES
// ============================================================================
setInterval(() => {
  const now = Date.now();
  const EXPIRE_MS = 24 * 60 * 60 * 1000;

  for (const [inviteId, invite] of Object.entries(invites)) {
    if (now - invite.createdAt > EXPIRE_MS) {
      console.log(`[CLEANUP] Removing expired invite: ${inviteId}`);
      delete invites[inviteId];
    }
  }
}, 60 * 60 * 1000);

// ============================================================================
// START SERVER
// ============================================================================
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════╗
║   🚀 RaDelfi Server Running        ║
║   Port: ${PORT}
║   Environment: ${process.env.NODE_ENV || 'development'}
║   Expo Experience: ${EXPO_EXPERIENCE_ID}
╚════════════════════════════════════╝
  `.trim());
});

process.on('SIGTERM', () => {
  console.log('[SERVER] SIGTERM received, shutting down...');
  server.close(() => {
    console.log('[SERVER] Closed out remaining connections');
    process.exit(0);
  });
});

module.exports = { app, server, io, users, invites };