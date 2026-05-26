require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || "lexia-cabinet-secret-2026";
const SUPER_PASSWORD = process.env.SUPER_PASSWORD || "LexiaSuper2026#";

// ── Data paths ──
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "../data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const LICENCES_FILE = path.join(DATA_DIR, "licences.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return def; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── Init Super Admin ──
function initUsers() {
  ensureDir();
  const users = loadJSON(USERS_FILE, null);
  if (!users) {
    const superHash = bcrypt.hashSync(SUPER_PASSWORD, 10);
    saveJSON(USERS_FILE, [
      { id: 1, email: "super@lexia.ma", password: superHash, role: "super", nom: "Super Admin", createdAt: new Date().toISOString() }
    ]);
    console.log("✅ Super Admin créé : super@lexia.ma");
  } else {
    if (!users.find(u => u.role === "super")) {
      const superHash = bcrypt.hashSync(SUPER_PASSWORD, 10);
      users.unshift({ id: Date.now(), email: "super@lexia.ma", password: superHash, role: "super", nom: "Super Admin", createdAt: new Date().toISOString() });
      saveJSON(USERS_FILE, users);
      console.log("✅ Super Admin ajouté");
    }
  }
}

// ── Licence helpers ──
function genKey(plan) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const seg = () => Array.from({length:5}, () => chars[Math.floor(Math.random()*chars.length)]).join("");
  const suffix = plan === "monthly" ? "30J" : plan === "yearly" ? "1AN" : "VIE";
  return `LEXIA-${seg()}-${seg()}-${suffix}`;
}

function checkLicence(user) {
  if (user.role === "super") return { valid: true, plan: "super" };
  if (!user.licenceKey) return { valid: false, reason: "Aucune licence" };
  const licences = loadJSON(LICENCES_FILE, []);
  const lic = licences.find(l => l.key === user.licenceKey);
  if (!lic) return { valid: false, reason: "Clé invalide" };
  if (lic.plan === "lifetime") return { valid: true, plan: "lifetime" };
  const now = new Date();
  const exp = new Date(lic.expiresAt);
  if (now > exp) return { valid: false, reason: "Licence expirée le " + exp.toLocaleDateString("fr-FR") };
  const days = Math.ceil((exp - now) / 86400000);
  return { valid: true, plan: lic.plan, expiresAt: lic.expiresAt, daysLeft: days };
}

// ── Middleware ──
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "../public")));

function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Non authentifié" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: "Token invalide" }); }
}

function superOnly(req, res, next) {
  if (req.user.role !== "super") return res.status(403).json({ error: "Super Admin requis" });
  next();
}

// ── Routes Auth ──
app.get("/health", (req, res) => res.json({ status: "ok", service: "LEXIA Cabinet Juridique" }));

app.post("/api/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email et mot de passe requis" });
  const users = loadJSON(USERS_FILE, []);
  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: "Email ou mot de passe incorrect" });
  const lic = checkLicence(user);
  if (!lic.valid) return res.status(403).json({ error: lic.reason, licenceRequired: true });
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role, nom: user.nom }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: { id: user.id, email: user.email, role: user.role, nom: user.nom }, licence: lic });
});

app.post("/api/activate-licence", (req, res) => {
  const { email, password, licenceKey } = req.body;
  if (!email || !password || !licenceKey) return res.status(400).json({ error: "Champs manquants" });
  const users = loadJSON(USERS_FILE, []);
  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: "Email ou mot de passe incorrect" });
  const licences = loadJSON(LICENCES_FILE, []);
  const lic = licences.find(l => l.key === licenceKey.trim().toUpperCase());
  if (!lic) return res.status(404).json({ error: "Clé de licence introuvable" });
  if (lic.usedBy && lic.usedBy !== user.email) return res.status(400).json({ error: "Clé déjà utilisée par un autre compte" });
  // Assign
  lic.usedBy = user.email;
  lic.activatedAt = new Date().toISOString();
  saveJSON(LICENCES_FILE, licences);
  user.licenceKey = licenceKey.trim().toUpperCase();
  saveJSON(USERS_FILE, users);
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role, nom: user.nom }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: { id: user.id, email: user.email, role: user.role, nom: user.nom }, licence: checkLicence(user) });
});

app.post("/api/register", (req, res) => {
  const { email, password, nom } = req.body;
  if (!email || !password || !nom) return res.status(400).json({ error: "Champs manquants" });
  const users = loadJSON(USERS_FILE, []);
  if (users.find(u => u.email.toLowerCase() === email.toLowerCase()))
    return res.status(400).json({ error: "Email déjà utilisé" });
  const hash = bcrypt.hashSync(password, 10);
  const newUser = { id: Date.now(), email: email.toLowerCase(), password: hash, nom, role: "client", createdAt: new Date().toISOString() };
  users.push(newUser);
  saveJSON(USERS_FILE, users);
  res.json({ message: "Compte créé. Activez votre licence pour accéder à l'application." });
});

app.get("/api/me", auth, (req, res) => {
  const users = loadJSON(USERS_FILE, []);
  const user = users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable" });
  res.json({ user: { id: user.id, email: user.email, role: user.role, nom: user.nom }, licence: checkLicence(user) });
});

// ── Data routes (per user) ──
app.get("/api/data/:key", auth, (req, res) => {
  const file = path.join(DATA_DIR, `user_${req.user.id}_${req.params.key}.json`);
  res.json(loadJSON(file, null));
});

app.post("/api/data/:key", auth, (req, res) => {
  ensureDir();
  const file = path.join(DATA_DIR, `user_${req.user.id}_${req.params.key}.json`);
  saveJSON(file, req.body);
  res.json({ ok: true });
});

// ── Super Admin routes ──
app.get("/api/admin/users", auth, superOnly, (req, res) => {
  const users = loadJSON(USERS_FILE, []);
  const licences = loadJSON(LICENCES_FILE, []);
  res.json(users.map(u => ({
    id: u.id, email: u.email, nom: u.nom, role: u.role,
    createdAt: u.createdAt, licenceKey: u.licenceKey,
    licence: u.role === "super" ? { valid: true, plan: "super" } : checkLicence(u)
  })));
});

app.get("/api/admin/licences", auth, superOnly, (req, res) => {
  res.json(loadJSON(LICENCES_FILE, []));
});

app.post("/api/admin/generate-licence", auth, superOnly, (req, res) => {
  const { plan, count = 1 } = req.body;
  if (!["monthly","yearly","lifetime"].includes(plan))
    return res.status(400).json({ error: "Plan invalide" });
  const licences = loadJSON(LICENCES_FILE, []);
  const now = new Date();
  const generated = [];
  for (let i = 0; i < Math.min(count, 20); i++) {
    const key = genKey(plan);
    const expiresAt = plan === "lifetime" ? null :
      new Date(now.getTime() + (plan === "monthly" ? 30 : 365) * 86400000).toISOString();
    const lic = { key, plan, createdAt: now.toISOString(), expiresAt, usedBy: null };
    licences.push(lic);
    generated.push(lic);
  }
  saveJSON(LICENCES_FILE, licences);
  res.json({ generated });
});

app.delete("/api/admin/user/:id", auth, superOnly, (req, res) => {
  let users = loadJSON(USERS_FILE, []);
  const id = parseInt(req.params.id);
  if (users.find(u => u.id === id && u.role === "super"))
    return res.status(400).json({ error: "Impossible de supprimer le Super Admin" });
  users = users.filter(u => u.id !== id);
  saveJSON(USERS_FILE, users);
  res.json({ ok: true });
});

app.post("/api/admin/reset-password", auth, superOnly, (req, res) => {
  const { userId, newPassword } = req.body;
  const users = loadJSON(USERS_FILE, []);
  const user = users.find(u => u.id === parseInt(userId));
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable" });
  user.password = bcrypt.hashSync(newPassword, 10);
  saveJSON(USERS_FILE, users);
  res.json({ ok: true });
});

// ── Serve app ──
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

initUsers();
app.listen(PORT, () => console.log(`✦ LEXIA Server port ${PORT}`));
