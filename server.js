const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const admin = require("firebase-admin");
const serviceAccount = require("./service-account.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const PORT = 3001;

// { userId: { socketId, name, partnerId, location, fcmToken } }
const users = {};

// { inviteId: { from, to, status } }
const invites = {};

app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "RaDelfi running", users: Object.keys(users) });
});

let serverUrl = "";
app.get("/api/server-url", (req, res) => res.json({ url: serverUrl }));
app.post("/api/server-url", (req, res) => {
  serverUrl = req.body.url;
  res.json({ ok: true });
});

// App kirim FCM token ke server waktu register
app.post("/api/register-token", (req, res) => {
  const { userId, fcmToken } = req.body;
  if (!userId || !fcmToken) return res.status(400).json({ ok: false });

  if (users[userId]) {
    users[userId].fcmToken = fcmToken;
  } else {
    // Simpan dulu meski belum connect socket
    users[userId] = {
      socketId: null,
      name: null,
      partnerId: null,
      location: null,
      fcmToken,
    };
  }

  console.log(`[FCM] Token registered: ${userId}`);
  res.json({ ok: true });
});

// Helper kirim FCM ke user yang offline
const sendFCM = async (fcmToken, title, body, data = {}) => {
  try {
    await admin.messaging().send({
      token: fcmToken,
      notification: { title, body },
      data,
      android: {
        priority: "high",
        notification: {
          channelId: "radelfi",
          sound: "default",
          vibrateTimingsMillis: [0, 300, 100, 300],
        },
      },
    });
    console.log(`[FCM] Sent to token: ${fcmToken.slice(0, 20)}...`);
  } catch (e) {
    console.error("[FCM] Error:", e.message);
  }
};

io.on("connection", (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  socket.on("register", (data) => {
    const { userId, name, partnerId, fcmToken } = data;

    if (!userId || !name) {
      socket.emit("error", "userId and name required");
      return;
    }

    const existingToken = users[userId]?.fcmToken;

    users[userId] = {
      socketId: socket.id,
      name,
      partnerId: partnerId || null,
      location: null,
      fcmToken: fcmToken || existingToken || null,
    };
    socket.userId = userId;

    console.log(`[✓] Registered: ${userId} (${name})`);
    socket.emit("registered", { userId, message: "Connected" });

    if (partnerId && users[partnerId]) {
      socket.emit("partner_status", {
        online: true,
        name: users[partnerId].name,
        userId: partnerId,
      });

      io.to(users[partnerId].socketId).emit("partner_status", {
        online: true,
        name,
        userId,
      });
    }
  });

  // === INVITE SYSTEM ===

  socket.on("send_invite", ({ from, to }) => {
    if (!from || !to) return socket.emit("error", "Invalid invite data");

    const target = users[to];
    if (!target) {
      socket.emit("invite_result", {
        success: false,
        message: `User ${to} tidak ditemukan`,
      });
      return;
    }

    const inviteId = `${from}-${to}-${Date.now()}`;
    invites[inviteId] = { from, to, status: "pending" };

    if (target.socketId && io.sockets.sockets.get(target.socketId)) {
      // Online → socket
      io.to(target.socketId).emit("incoming_invite", {
        inviteId,
        from,
        fromName: users[from]?.name || from,
      });
    } else if (target.fcmToken) {
      // Offline → FCM
      sendFCM(
        target.fcmToken,
        "💌 Undangan Masuk",
        `${users[from]?.name || from} mengundang kamu jadi partner`,
        { type: "invite", inviteId, from, fromName: users[from]?.name || from },
      );
    }

    socket.emit("invite_sent", { inviteId, to });
    console.log(`[→] Invite: ${from} → ${to}`);
  });

  socket.on("respond_invite", ({ inviteId, accept }) => {
    const invite = invites[inviteId];
    if (!invite) return socket.emit("error", "Invite tidak ditemukan");

    invite.status = accept ? "accepted" : "rejected";

    const senderUser = users[invite.from];
    const responderUser = users[invite.to];

    if (accept) {
      if (users[invite.from]) users[invite.from].partnerId = invite.to;
      if (users[invite.to]) users[invite.to].partnerId = invite.from;

      if (senderUser) {
        if (
          senderUser.socketId &&
          io.sockets.sockets.get(senderUser.socketId)
        ) {
          io.to(senderUser.socketId).emit("invite_accepted", {
            by: invite.to,
            byName: responderUser?.name || invite.to,
          });
          io.to(senderUser.socketId).emit("partner_status", {
            online: true,
            name: responderUser?.name || invite.to,
            userId: invite.to,
          });
        } else if (senderUser.fcmToken) {
          sendFCM(
            senderUser.fcmToken,
            "✅ Undangan Diterima",
            `${responderUser?.name || invite.to} menerima undangan kamu`,
            { type: "invite_accepted" },
          );
        }
      }

      socket.emit("partner_status", {
        online: true,
        name: senderUser?.name || invite.from,
        userId: invite.from,
      });

      console.log(`[✓] Invite accepted: ${invite.from} ↔ ${invite.to}`);
    } else {
      if (senderUser?.socketId && io.sockets.sockets.get(senderUser.socketId)) {
        io.to(senderUser.socketId).emit("invite_rejected", {
          by: invite.to,
          byName: responderUser?.name || invite.to,
        });
      }
      console.log(`[✗] Invite rejected: ${invite.from} ✗ ${invite.to}`);
    }

    delete invites[inviteId];
  });

  // Ping — FCM kalau partner offline
  socket.on("ping", (data) => {
    const { from, to } = data;
    if (!from || !to) return socket.emit("error", "Invalid ping data");

    const target = users[to];
    if (!target) return socket.emit("error", `User ${to} not found`);

    const fromName = users[from]?.name || from;

    if (target.socketId && io.sockets.sockets.get(target.socketId)) {
      // Online → socket seperti biasa
      io.to(target.socketId).emit("ping", {
        from,
        fromName,
        timestamp: new Date().toISOString(),
      });
    } else if (target.fcmToken) {
      // Offline → FCM
      sendFCM(
        target.fcmToken,
        "💛 Rasa Masuk",
        `${fromName} lagi kangen kamu`,
        { type: "ping", from, fromName },
      );
    } else {
      socket.emit("error", `${to} offline dan belum punya FCM token`);
    }

    console.log(`[>>>] Ping: ${from} → ${to}`);
  });

  socket.on("location_update", (data) => {
    const { userId, lat, lng } = data;
    if (!userId || lat == null || lng == null) return;
    if (!users[userId]) return;

    users[userId].location = { lat, lng, timestamp: new Date().toISOString() };

    const partnerId = users[userId].partnerId;
    if (partnerId && users[partnerId]?.socketId) {
      io.to(users[partnerId].socketId).emit("location_update", {
        from: userId,
        lat,
        lng,
        timestamp: users[userId].location.timestamp,
      });
    }
  });

  socket.on("disconnect", () => {
    const userId = socket.userId;
    if (!userId || !users[userId]) return;

    const partnerId = users[userId].partnerId;
    const fcmToken = users[userId].fcmToken;

    // Jangan delete user, cukup null-kan socketId
    // Biar FCM token tetap tersimpan untuk ping offline
    users[userId].socketId = null;

    if (partnerId && users[partnerId]?.socketId) {
      io.to(users[partnerId].socketId).emit("partner_status", {
        online: false,
        userId,
      });
    }

    console.log(
      `[-] Disconnected: ${userId} (token ${fcmToken ? "kept" : "none"})`,
    );
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[RaDelfi] Running on :${PORT}`);
});
