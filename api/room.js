import Pusher from "pusher";

const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true,
});

// In-memory store (resets on cold start – fine for party games)
const rooms = {};

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const { action, roomCode, playerId, playerName, data } = req.body;

  switch (action) {
    case "create": {
      const code = Math.random().toString(36).substr(2, 6).toUpperCase();
      rooms[code] = {
        status: "lobby",
        host: playerId,
        players: [{ id: playerId, name: playerName, isHost: true }],
        questions: [],
        currentQ: 0,
        scores: {},
        answers: {},
        settings: { cat: "mix", diff: 1, count: 10 },
        createdAt: Date.now(),
      };
      return res.status(200).json({ roomCode: code, room: rooms[code] });
    }

    case "join": {
      const room = rooms[roomCode];
      if (!room) return res.status(404).json({ error: "Raum nicht gefunden!" });
      if (room.status !== "lobby") return res.status(400).json({ error: "Spiel läuft bereits!" });
      if (room.players.length >= 8) return res.status(400).json({ error: "Raum ist voll!" });
      room.players.push({ id: playerId, name: playerName, isHost: false });
      await pusher.trigger(`room-${roomCode}`, "player-joined", { players: room.players });
      return res.status(200).json({ room });
    }

    case "update-settings": {
      const room = rooms[roomCode];
      if (!room) return res.status(404).json({ error: "Raum nicht gefunden!" });
      room.settings = { ...room.settings, ...data };
      return res.status(200).json({ ok: true });
    }

    case "start": {
      const room = rooms[roomCode];
      if (!room) return res.status(404).json({ error: "Raum nicht gefunden!" });
      room.questions = data.questions;
      room.currentQ = 0;
      room.status = "playing";
      room.answers = {};
      await pusher.trigger(`room-${roomCode}`, "game-started", {
        questions: room.questions,
        settings: room.settings,
      });
      return res.status(200).json({ ok: true });
    }

    case "answer": {
      const room = rooms[roomCode];
      if (!room) return res.status(404).json({ error: "Raum nicht gefunden!" });
      const qIdx = data.qIdx;
      if (!room.answers[qIdx]) room.answers[qIdx] = {};
      room.answers[qIdx][playerId] = { chosen: data.chosen, correct: data.correct, pts: data.pts, name: playerName };

      const answered = Object.keys(room.answers[qIdx]).length;
      const total = room.players.length;
      await pusher.trigger(`room-${roomCode}`, "answer-update", { answered, total, qIdx });

      if (answered >= total) {
        await triggerReveal(room, roomCode, qIdx);
      }
      return res.status(200).json({ ok: true });
    }

    case "reveal": {
      const room = rooms[roomCode];
      if (!room) return res.status(404).json({ error: "Raum nicht gefunden!" });
      await triggerReveal(room, roomCode, data.qIdx);
      return res.status(200).json({ ok: true });
    }

    case "next": {
      const room = rooms[roomCode];
      if (!room) return res.status(404).json({ error: "Raum nicht gefunden!" });
      room.currentQ++;
      room.status = "playing";
      await pusher.trigger(`room-${roomCode}`, "next-question", { qIdx: room.currentQ });
      return res.status(200).json({ ok: true });
    }

    case "final": {
      const room = rooms[roomCode];
      if (!room) return res.status(404).json({ error: "Raum nicht gefunden!" });
      room.status = "final";
      const scores = buildScores(room);
      await pusher.trigger(`room-${roomCode}`, "game-final", { scores });
      return res.status(200).json({ ok: true });
    }

    case "get": {
      return res.status(200).json({ room: rooms[roomCode] || null });
    }

    default:
      return res.status(400).json({ error: "Unknown action" });
  }
}

async function triggerReveal(room, roomCode, qIdx) {
  const scores = buildScores(room);
  const answers = room.answers[qIdx] || {};
  room.status = "reveal";
  await pusher.trigger(`room-${roomCode}`, "reveal", {
    qIdx,
    answers,
    scores,
    isLast: qIdx >= room.questions.length - 1,
  });
}

function buildScores(room) {
  const totals = {};
  room.players.forEach((p) => { totals[p.id] = { id: p.id, name: p.name, total: 0, correct: 0 }; });
  Object.values(room.answers).forEach((qAnswers) => {
    Object.values(qAnswers).forEach((a) => {
      if (totals[a.id] === undefined) return;
      totals[a.id].total += a.pts || 0;
      if (a.chosen === a.correct) totals[a.id].correct++;
    });
  });
  return Object.values(totals).sort((a, b) => b.total - a.total);
}
