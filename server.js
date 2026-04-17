// server/server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const admin = require("firebase-admin");
const serviceAccount = require("./service-account.json");

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
    origin: process.env.CORS_ORIGIN || "*", 
    methods: ["GET", "POST", "PUT", "DELETE"] 
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

const PORT = process.env.PORT || 3001;

// ============================================================================
// CONFIG EXPO - GANTI DENGAN NILAI ANDA
// ============================================================================
const EXPO_EXPERIENCE_ID = '@yourUsername/RaDelfi'; // Format: @username/slug
const EXPO_SCOPE_KEY = '@yourUsername/RaDelfi';     // Sama dengan experienceId

// ============================================================================
// IN-MEMORY STORE (ganti dengan Redis/DB untuk production)
// { userId: { socketId, name, partnerId, location, fcmToken, platform } }
// ============================================================================
const users = {};
const invites = {};

app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({ 
    status: "RaDelfi API Running", 
    users: Object.keys(users).length,
    invites: Object.keys(invites).length,
    timestamp: new Date().toISOString()
  });
});

// Server URL discovery (untuk client fetch dynamic URL)
let serverUrl = "";
app.get("/api/server-url", (req, res) => res.json({ url: serverUrl || `http://localhost:${PORT}` }));
app.post("/api/server-url", (req, res) => {
  serverUrl = req.body.url;
  console.log(`[API] Server URL updated: ${serverUrl}`);
  res.json({ ok: true });
});

// ============================================================================
// FCM TOKEN REGISTRATION
// ============================================================================
app.post("/api/register-token", async (req, res) => {
  const { userId, fcmToken, platform = 'android' } = req.body;
  
  if (!userId || !fcmToken) {
    return res.status(400).json({ ok: false, error: 'userId and fcmToken required' });
  }

  try {
    // Update atau create user entry
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
// FCM SENDER - HYBRID PAYLOAD UNTUK EXPO
// ============================================================================
const sendFCM = async (fcmToken, title, body, data = {}, priority = 'high') => {
  try {
    const message = {
      token: fcmToken,
      
      // Notification payload: ditangani OS untuk display
      notification: {
        title,
        body,
      },
      
      // Data payload: ditangani app untuk logic custom
      // WAJIB: experienceId & scopeKey untuk Expo managed workflow
      data: {
        ...data,
        experienceId: EXPO_EXPERIENCE_ID,
        scopeKey: EXPO_SCOPE_KEY,
        timestamp: Date.now().toString(),
      },
      
      // Android specific config
      android: {
        priority, // 'high' atau 'normal'
        ttl: 3600, // 1 jam - pesan kadaluarsa jika tidak terkirim
        notification: {
          channelId: 'radelfi-ping', // Harus match dengan channel di client
          sound: 'default',
          // Vibration pattern via FCM kurang reliable, 
          // lebih baik handle di client via notification channel
        },
      },
      
      // iOS specific config untuk background update
      apns: {
        payload: {
          aps: {
            alert: { title, body },
            sound: 'default',
            contentAvailable: true, // ✅ Wake app di background (iOS)
            mutableContent: true,   // ✅ Allow notification service extension
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
    
    // Handle invalid token - cleanup dari store
    if (error.code === 'messaging/invalid-registration-token' ||
        error.code === 'messaging/registration-token-not-registered') {
      
      // Cari userId yang punya token ini dan hapus
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
io.on("connection", (socket) => {
  console.log(`[SOCKET] + Connected: ${socket.id} from ${socket.handshake.address}`);

  // --------------------------------------------------------------------------
  // REGISTER USER
  // --------------------------------------------------------------------------
  socket.on("register", (data) => {
    const { userId, name, partnerId, fcmToken, platform = 'android' } = data;

    if (!userId || !name) {
      socket.emit("error", "userId and name are required");
      return;
    }

    // Preserve existing fcmToken jika tidak dikirim ulang
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
    
    socket.emit("registered", { 
      userId, 
      message: "Connected successfully",
      timestamp: Date.now()
    });

    // Notify partner jika online
    if (partnerId && users[partnerId]) {
      const partnerData = users[partnerId];
      
      // Emit ke partner via socket jika online
      if (partnerData.socketId && io.sockets.sockets.get(partnerData.socketId)) {
        io.to(partnerData.socketId).emit("partner_status", {
          online: true,
          name,
          userId,
          timestamp: Date.now(),
        });
      }
      // Fallback: kirim FCM jika partner offline (opsional, untuk "partner online" notification)
      // Biasanya tidak perlu karena partner akan tahu saat buka app
    }
  });

  // --------------------------------------------------------------------------
  // INVITE SYSTEM
  // --------------------------------------------------------------------------
  socket.on("send_invite", ({ from, to }) => {
    if (!from || !to) {
      socket.emit("invite_result", { success: false, message: "Invalid invite data" });
      return;
    }

    const target = users[to];
    if (!target) {
      socket.emit("invite_result", { success: false, message: `User ${to} not found` });
      return;
    }

    const inviteId = `${from}-${to}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    invites[inviteId] = { from, to, status: "pending", createdAt: Date.now() };

    const fromName = users[from]?.name || from;
    const invitePayload = {
      inviteId,
      from,
      fromName,
      type: 'invite',
    };

    if (target.socketId && io.sockets.sockets.get(target.socketId)) {
      // Target online → kirim via socket
      io.to(target.socketId).emit("incoming_invite", invitePayload);
      console.log(`[INVITE] ${from} → ${to} (via socket)`);
    } else if (target.fcmToken) {
      // Target offline → kirim via FCM
      sendFCM(
        target.fcmToken,
        "💌 Undangan Masuk",
        `${fromName} mengundang kamu jadi partner`,
        invitePayload,
        'high'
      ).then(result => {
        if (!result.success) {
          socket.emit("invite_result", { 
            success: false, 
            message: "Failed to send invite (FCM error)",
            fcmError: result.error 
          });
        }
      });
      console.log(`[INVITE] ${from} → ${to} (via FCM)`);
    } else {
      socket.emit("invite_result", { 
        success: false, 
        message: `${to} is offline and has no FCM token registered` 
      });
      console.log(`[INVITE] ${from} → ${to} (FAILED: no token)`);
      return;
    }

    socket.emit("invite_sent", { inviteId, to, timestamp: Date.now() });
  });

  socket.on("respond_invite", ({ inviteId, accept }) => {
    const invite = invites[inviteId];
    if (!invite) {
      socket.emit("error", "Invite not found or expired");
      return;
    }

    invite.status = accept ? "accepted" : "rejected";
    invite.respondedAt = Date.now();

    const sender = users[invite.from];
    const responder = users[invite.to];
    const responderName = responder?.name || invite.to;

    if (accept) {
      // Update partnership bidirectional
      if (sender) sender.partnerId = invite.to;
      if (responder) responder.partnerId = invite.from;

      // Notify sender
      if (sender?.socketId && io.sockets.sockets.get(sender.socketId)) {
        io.to(sender.socketId).emit("invite_accepted", {
          by: invite.to,
          byName: responderName,
          timestamp: Date.now(),
        });
        // Update partner status immediately
        io.to(sender.socketId).emit("partner_status", {
          online: true,
          name: responderName,
          userId: invite.to,
        });
      } else if (sender?.fcmToken) {
        // Fallback FCM untuk sender yang offline
        sendFCM(
          sender.fcmToken,
          "✅ Undangan Diterima",
          `${responderName} menerima undangan kamu!`,
          { type: "invite_accepted", by: invite.to, byName: responderName },
          'normal' // Tidak urgent
        );
      }

      // Notify responder (yang sedang respond)
      socket.emit("partner_status", {
        online: sender?.socketId ? true : false,
        name: sender?.name || invite.from,
        userId: invite.from,
      });

      console.log(`[INVITE] ✓ Accepted: ${invite.from} ↔ ${invite.to}`);
    } else {
      // Notify sender of rejection
      if (sender?.socketId && io.sockets.sockets.get(sender.socketId)) {
        io.to(sender.socketId).emit("invite_rejected", {
          by: invite.to,
          byName: responderName,
          timestamp: Date.now(),
        });
      }
      console.log(`[INVITE] ✗ Rejected: ${invite.from} ✗ ${invite.to}`);
    }

    // Cleanup invite
    delete invites[inviteId];
  });

  // --------------------------------------------------------------------------
  // PING SYSTEM - CORE FEATURE
  // --------------------------------------------------------------------------
  socket.on("ping", (data) => {
    const { from, to, customMessage } = data;
    
    if (!from || !to) {
      socket.emit("error", "Invalid ping data: from and to required");
      return;
    }

    const target = users[to];
    if (!target) {
      socket.emit("error", `User ${to} not found`);
      return;
    }

    const fromName = users[from]?.name || from;
    const pingPayload = {
      from,
      fromName,
      type: 'ping',
      timestamp: Date.now().toString(),
      ...(customMessage && { customMessage }),
    };

    if (target.socketId && io.sockets.sockets.get(target.socketId)) {
      // ✅ Target ONLINE: kirim via Socket.IO (real-time)
      io.to(target.socketId).emit("ping", {
        ...pingPayload,
        via: 'socket',
      });
      console.log(`[PING] ${from} → ${to} (via socket)`);
      
    } else if (target.fcmToken) {
      // ✅ Target OFFLINE: kirim via FCM (fallback)
      sendFCM(
        target.fcmToken,
        "💛 Rasa Masuk",
        `${fromName} lagi kangen kamu${customMessage ? `: ${customMessage}` : ''}`,
        pingPayload,
        'high' // ✅ High priority agar wake device
      ).then(result => {
        if (!result.success) {
          socket.emit("error", `Failed to send ping via FCM: ${result.error}`);
        }
      });
      console.log(`[PING] ${from} → ${to} (via FCM)`);
      
    } else {
      // ❌ Tidak ada cara kirim
      socket.emit("error", `${to} is offline and no FCM token registered`);
      console.log(`[PING] ${from} → ${to} (FAILED: no token)`);
    }
  });

  // --------------------------------------------------------------------------
  // LOCATION SHARING
  // --------------------------------------------------------------------------
  socket.on("location_update", (data) => {
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

    // Update user location
    userData.location = {
      lat,
      lng,
      accuracy: accuracy || null,
      timestamp: clientTimestamp || new Date().toISOString(),
      receivedAt: Date.now(),
    };

    // Forward to partner if exists and online
    const partnerId = userData.partnerId;
    if (partnerId && users[partnerId]?.socketId) {
      const partnerSocket = users[partnerId].socketId;
      if (io.sockets.sockets.get(partnerSocket)) {
        io.to(partnerSocket).emit("location_update", {
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

  // --------------------------------------------------------------------------
  // DISCONNECT HANDLER
  // --------------------------------------------------------------------------
  socket.on("disconnect", (reason) => {
    const userId = socket.userId;
    if (!userId || !users[userId]) {
      console.log(`[SOCKET] - Disconnected unknown: ${socket.id} (${reason})`);
      return;
    }

    const userData = users[userId];
    const partnerId = userData.partnerId;
    const fcmToken = userData.fcmToken;

    // ⚠️ PENTING: Jangan delete user, cukup null-kan socketId
    // Agar fcmToken tetap tersimpan untuk fallback saat offline
    users[userId].socketId = null;
    users[userId].lastSeen = Date.now();
    users[userId].status = 'offline';

    console.log(`[SOCKET] - Disconnected: ${userId} (${reason}) | Token: ${fcmToken ? 'kept' : 'none'}`);

    // Notify partner that this user went offline
    if (partnerId && users[partnerId]?.socketId) {
      const partnerSocket = users[partnerId].socketId;
      if (io.sockets.sockets.get(partnerSocket)) {
        io.to(partnerSocket).emit("partner_status", {
          online: false,
          userId,
          lastSeen: users[userId].lastSeen,
          reason,
        });
      }
    }
  });

  // Optional: handle socket errors
  socket.on("error", (error) => {
    console.error(`[SOCKET] Error on ${socket.userId || socket.id}:`, error);
  });
});

// ============================================================================
// CLEANUP: Hapus invite kadaluarsa (opsional, untuk production)
// ============================================================================
setInterval(() => {
  const now = Date.now();
  const EXPIRE_MS = 24 * 60 * 60 * 1000; // 24 jam
  
  for (const [inviteId, invite] of Object.entries(invites)) {
    if (now - invite.createdAt > EXPIRE_MS) {
      console.log(`[CLEANUP] Removing expired invite: ${inviteId}`);
      delete invites[inviteId];
    }
  }
  
  // Optional: cleanup users yang tidak aktif > 7 hari
  // (Hati-hati: jangan hapus jika masih butuh fcmToken)
}, 60 * 60 * 1000); // Jalankan tiap jam

// ============================================================================
// START SERVER
// ============================================================================
server.listen(PORT, "0.0.0.0", () => {
  console.log(`
╔════════════════════════════════════╗
║   🚀 RaDelfi Server Running        ║
║   Port: ${PORT}
║   Environment: ${process.env.NODE_ENV || 'development'}
║   Expo Experience: ${EXPO_EXPERIENCE_ID}
╚════════════════════════════════════╝
  `.trim());
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[SERVER] SIGTERM received, shutting down...');
  server.close(() => {
    console.log('[SERVER] Closed out remaining connections');
    process.exit(0);
  });
});

module.exports = { app, server, io, users, invites };