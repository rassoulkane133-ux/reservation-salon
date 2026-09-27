// Service de rendez-vous — créneaux, réservation, rappel (SMS ou email), écran du jour
// --------------------------------------------------------------------------------
require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const twilio = require("twilio");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json());

const DB_FILE = path.join(__dirname, "bookings.json");

// ---------- Stockage simple (fichier JSON) ----------
function readBookings() {
  if (!fs.existsSync(DB_FILE)) return [];
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}
function writeBookings(bookings) {
  fs.writeFileSync(DB_FILE, JSON.stringify(bookings, null, 2));
}
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------- Protection par mot de passe (tableau de bord) ----------
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
    if (user === process.env.DASHBOARD_USER && pass === process.env.DASHBOARD_PASSWORD) {
      return next();
    }
  }
  res.set("WWW-Authenticate", 'Basic realm="Tableau de bord"');
  return res.status(401).send("Authentification requise.");
}

app.get("/dashboard.html", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});
app.use("/api/bookings/today", requireAuth);

app.use(express.static(path.join(__dirname, "public")));

// ---------- Créneaux libres d'un jour donné ----------
app.get("/api/bookings/day", (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "Paramètre 'date' requis." });
  const bookings = readBookings();
  const taken = bookings.filter((b) => b.date === date).map((b) => b.time);
  res.json({ taken });
});

// ---------- Rendez-vous du jour (écran de l'entreprise) ----------
app.get("/api/bookings/today", (req, res) => {
  const bookings = readBookings()
    .filter((b) => b.date === todayKey())
    .sort((a, b) => a.time.localeCompare(b.time));
  res.json(bookings);
});

// ---------- Nouvelle réservation ----------
// Body attendu : { name, phone, channel: "sms"|"email", email?, date, time }
app.post("/api/bookings", (req, res) => {
  const { name, phone, channel, email, date, time } = req.body;

  if (!name || !phone || !date || !time || !["sms", "email"].includes(channel)) {
    return res.status(400).json({ error: "Champs manquants ou invalides." });
  }
  if (channel === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || "")) {
    return res.status(400).json({ error: "Adresse email invalide." });
  }

  const bookings = readBookings();
  const alreadyTaken = bookings.some((b) => b.date === date && b.time === time);
  if (alreadyTaken) {
    return res.status(409).json({ error: "Ce créneau vient d'être réservé par quelqu'un d'autre." });
  }

  bookings.push({
    id: Date.now().toString(36),
    name,
    phone,
    channel,
    email: channel === "email" ? email : null,
    date,
    time,
    reminderSent: false
  });
  writeBookings(bookings);
  res.json({ ok: true });
});

// ---------- Envoi SMS (Twilio) ----------
const twilioClient = process.env.TWILIO_SID
  ? twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

async function sendSms(booking) {
  if (!twilioClient) throw new Error("Identifiants Twilio manquants (.env)");
  return twilioClient.messages.create({
    from: process.env.TWILIO_FROM_NUMBER,
    to: booking.phone,
    body: buildTextMessage(booking)
  });
}

// ---------- Envoi email (SMTP) ----------
const mailTransporter = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
  : null;

async function sendEmail(booking) {
  if (!mailTransporter) throw new Error("Configuration SMTP manquante (.env)");
  const { dateLabel, timeLabel } = formatDateTime(booking);
  return mailTransporter.sendMail({
    from: process.env.SMTP_FROM,
    to: booking.email,
    subject: "Rappel de votre rendez-vous demain",
    text: `Bonjour ${booking.name},\n\nRappel : vous avez rendez-vous demain ${dateLabel} à ${timeLabel}.\n\nÀ bientôt !`
  });
}

function formatDateTime(booking) {
  const d = new Date(`${booking.date}T${booking.time}:00`);
  return {
    dateLabel: d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" }),
    timeLabel: d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
  };
}
function buildTextMessage(booking) {
  const { dateLabel, timeLabel } = formatDateTime(booking);
  return `Rappel : vous avez rendez-vous demain ${dateLabel} à ${timeLabel}. À bientôt !`;
}

// ---------- Vérification toutes les minutes ----------
cron.schedule("* * * * *", async () => {
  const bookings = readBookings();
  const now = Date.now();
  let changed = false;

  for (const booking of bookings) {
    if (booking.reminderSent) continue;
    const apptTime = new Date(`${booking.date}T${booking.time}:00`).getTime();
    const reminderTime = apptTime - 24 * 60 * 60 * 1000;
    if (now >= reminderTime && now < reminderTime + 60 * 1000) {
      try {
        if (booking.channel === "email") {
          await sendEmail(booking);
        } else {
          await sendSms(booking);
        }
        booking.reminderSent = true;
        changed = true;
        console.log(`Rappel envoyé à ${booking.name} (${booking.channel})`);
      } catch (err) {
        console.error(`Échec du rappel pour ${booking.name} :`, err.message);
      }
    }
  }
  if (changed) writeBookings(bookings);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Service actif sur le port ${PORT}`));
