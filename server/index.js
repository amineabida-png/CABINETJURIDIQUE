require("dotenv").config();
const fetch = (...args) => import("node-fetch").then(({default: f}) => f(...args));
const express = require("express");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const { createWorker } = require("tesseract.js");
const { execFile, exec } = require("child_process");
const os = require("os");

// ── Extraction texte PDF native (fallback sans librairie) ──
function extractPDFTextNative(buffer) {
  try {
    const str = buffer.toString("latin1");
    const texts = [];
    // Extraire blocs BT...ET
    let i = 0;
    while (i < str.length) {
      const bt = str.indexOf("BT", i);
      if (bt === -1) break;
      const et = str.indexOf("ET", bt + 2);
      if (et === -1) break;
      const block = str.slice(bt + 2, et);
      // Extraire strings entre parenthèses
      let j = 0;
      while (j < block.length) {
        const ps = block.indexOf("(", j);
        if (ps === -1) break;
        let pe = ps + 1, depth = 1;
        while (pe < block.length && depth > 0) {
          if (block[pe] === "(" && block[pe-1] !== "\\") depth++;
          else if (block[pe] === ")" && block[pe-1] !== "\\") depth--;
          pe++;
        }
        const raw = block.slice(ps + 1, pe - 1)
          .replace(/\\n/g, " ").replace(/\\r/g, " ")
          .replace(/\\t/g, " ").replace(/\\\\/g, "\\")
          .replace(/\\[()]/g, "");
        if (raw.trim().length > 0) texts.push(raw.trim());
        j = pe;
      }
      i = et + 2;
    }
    return texts.join(" ").replace(/\s+/g, " ").trim();
  } catch(e) {
    return "";
  }
}

// Multer : stockage en mémoire (pas de fichier sur disque)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Seuls les fichiers PDF sont acceptés"));
  }
});

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
app.use(express.static(path.join(__dirname, "../public"), {
  setHeaders: function(res, filePath) {
    if (filePath.endsWith('index.html') || filePath.endsWith('admin.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

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
  res.json(users.map(u => {
    const lic = u.role === "super" ? { valid: true, plan: "super" } : checkLicence(u);
    // Extraire expiry pour le frontend
    let licenceExpiry = null;
    let licencePlan = null;
    if (u.licenceKey) {
      const l = licences.find(x => x.key === u.licenceKey);
      if (l) { licenceExpiry = l.expiresAt || null; licencePlan = l.plan || null; }
    }
    return { id: u.id, email: u.email, nom: u.nom, role: u.role,
      createdAt: u.createdAt, licenceKey: u.licenceKey,
      licenceExpiry, licencePlan,
      licence: lic };
  }));
});

// ── DELETE user ──
app.delete("/api/admin/users/:id", auth, superOnly, (req, res) => {
  const users = loadJSON(USERS_FILE, []);
  const id = parseInt(req.params.id);
  const user = users.find(u => u.id === id);
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable" });
  if (user.role === "super") return res.status(403).json({ error: "Impossible de supprimer le Super Admin" });
  saveJSON(USERS_FILE, users.filter(u => u.id !== id));
  res.json({ ok: true });
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


// ── AI PDF Route — extraction texte + résumé/analyse ──
app.post("/api/ai/pdf", auth, upload.single("pdf"), async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Clé API Groq non configurée" });
  if (!req.file) return res.status(400).json({ error: "Aucun fichier PDF reçu" });

  try {
    // Extraction texte : essayer pdf-parse, sinon méthode native
    let texte = "";
    let numpages = 1;
    let charCount = 0;
    try {
      const pdfData = await pdfParse(req.file.buffer);
      texte = (pdfData.text || "").trim();
      numpages = pdfData.numpages || 1;
      charCount = pdfData.text ? pdfData.text.length : 0;
    } catch(e) {
      // Fallback extraction native
      texte = extractPDFTextNative(req.file.buffer);
      charCount = texte.length;
    }

    if (!texte || texte.length < 50)
      return res.status(400).json({ error: "Impossible d'extraire le texte de ce PDF. Si c'est un PDF scanné, activez le mode 📷 scanné." });

    const MAX_CHARS = 12000;
    const tronque = texte.length > MAX_CHARS;
    if (tronque) texte = texte.substring(0, MAX_CHARS) + "\n\n[... document tronqué à 12 000 caractères]";

    const prompt = req.body.prompt || "Résume ce document juridique de façon structurée. Identifie : les parties, l'objet, les faits, les arguments principaux, la décision ou conclusion, et les points importants à retenir.";

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: "Tu es un assistant juridique expert spécialisé dans le droit marocain. Analyse les documents juridiques avec précision et structure tes réponses clairement en français." },
          { role: "user", content: prompt + "\n\n---\nCONTENU DU DOCUMENT :\n" + texte }
        ],
        max_tokens: 2000,
        temperature: 0.2
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || "Erreur Groq" });

    res.json({
      reply: data.choices[0].message.content,
      filename: req.file.originalname,
      pages: numpages,
      chars: charCount,
      tronque
    });
  } catch (e) {
    res.status(500).json({ error: "Erreur traitement PDF : " + e.message });
  }
});

// ── AI PDF SCANNÉ — OCR via Tesseract.js + analyse Groq ──
app.post("/api/ai/pdf-scan", auth, upload.single("pdf"), async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Clé API Groq non configurée" });
  if (!req.file) return res.status(400).json({ error: "Aucun fichier PDF reçu" });

  const tmpDir = os.tmpdir();
  const tmpPDF = path.join(tmpDir, "scan_" + Date.now() + ".pdf");
  const tmpBase = path.join(tmpDir, "scan_" + Date.now());

  try {
    // Sauvegarder le PDF temporairement
    fs.writeFileSync(tmpPDF, req.file.buffer);

    // Convertir PDF en images via ghostscript (si dispo) ou pdftoppm
    let texteOCR = "";
    let method = "";

    // Méthode 1 : Ghostscript (meilleure qualité)
    const gsAvailable = await new Promise(r => exec("which gs", (e) => r(!e)));

    if (gsAvailable) {
      method = "ghostscript";
      await new Promise((resolve, reject) => {
        exec(`gs -dBATCH -dNOPAUSE -sDEVICE=png16m -r200 -sOutputFile="${tmpBase}_%03d.png" "${tmpPDF}"`,
          (err) => err ? reject(err) : resolve());
      });
    } else {
      // Méthode 2 : pdftoppm
      const pdftoppmAvail = await new Promise(r => exec("which pdftoppm", (e) => r(!e)));
      if (pdftoppmAvail) {
        method = "pdftoppm";
        await new Promise((resolve, reject) => {
          exec(`pdftoppm -r 200 -png "${tmpPDF}" "${tmpBase}"`,
            (err) => err ? reject(err) : resolve());
        });
      }
    }

    if (method) {
      // OCR sur chaque image générée (max 5 pages)
      const imgFiles = fs.readdirSync(tmpDir)
        .filter(f => f.startsWith(path.basename(tmpBase)) && f.endsWith(".png"))
        .sort()
        .slice(0, 5);

      if (imgFiles.length > 0) {
        const worker = await createWorker("fra+ara+eng");
        for (const imgFile of imgFiles) {
          const imgPath = path.join(tmpDir, imgFile);
          const { data } = await worker.recognize(imgPath);
          texteOCR += data.text + "\n\n";
          fs.unlinkSync(imgPath); // nettoyer
        }
        await worker.terminate();
      }
    }

    // Si pas de méthode système, utiliser tesseract.js directement sur le buffer
    // (moins précis mais 100% Node.js)
    if (!texteOCR.trim()) {
      method = "tesseract.js-direct";
      // Tesseract.js peut traiter des images mais pas directement les PDF
      // On informe l'utilisateur
      fs.unlinkSync(tmpPDF);
      return res.status(422).json({
        error: "PDF scanné détecté mais conversion impossible sur ce serveur. Essayez de convertir votre PDF en images JPG/PNG d'abord, ou utilisez un PDF avec texte sélectionnable.",
        tip: "Sur mobile : prenez une photo du document et utilisez le bouton 🖼 Image (à venir)"
      });
    }

    fs.unlinkSync(tmpPDF);

    if (!texteOCR.trim() || texteOCR.trim().length < 30) {
      return res.status(400).json({ error: "OCR n'a pas pu extraire de texte lisible. Vérifiez la qualité du scan." });
    }

    // Limiter et analyser avec Groq
    const MAX_CHARS = 12000;
    const tronque = texteOCR.length > MAX_CHARS;
    let texte = tronque ? texteOCR.substring(0, MAX_CHARS) + "\n\n[... tronqué]" : texteOCR;
    const prompt = req.body.prompt || "Ce texte provient d'un document scanné par OCR. Résume ce document juridique, identifie les parties, l'objet, les faits, la décision et les points importants. Ignore les erreurs OCR mineures.";

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: "Tu es un assistant juridique expert. Le texte fourni provient d'un OCR et peut contenir des imperfections. Analyse-le intelligemment en ignorant les artefacts OCR." },
          { role: "user", content: prompt + "\n\n---\nTEXTE OCR :\n" + texte }
        ],
        max_tokens: 2000,
        temperature: 0.2
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || "Erreur Groq" });

    res.json({
      reply: data.choices[0].message.content,
      filename: req.file.originalname,
      method: "OCR (" + method + ")",
      chars: texteOCR.length,
      tronque
    });

  } catch (e) {
    try { fs.unlinkSync(tmpPDF); } catch(_) {}
    res.status(500).json({ error: "Erreur OCR : " + e.message });
  }
});

// ── WHISPER — Transcription audio universelle (tous navigateurs) ──
const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

app.post("/api/ai/transcribe", auth, uploadAudio.single("audio"), async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Clé API Groq non configurée" });
  if (!req.file) return res.status(400).json({ error: "Aucun fichier audio reçu" });

  try {
    const lang = req.body.lang || "fr";
    const FormData = (await import("form-data")).default;
    const form = new FormData();
    form.append("file", req.file.buffer, {
      filename: "audio.webm",
      contentType: req.file.mimetype || "audio/webm"
    });
    form.append("model", "whisper-large-v3-turbo");
    form.append("language", lang);
    form.append("response_format", "json");

    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + apiKey, ...form.getHeaders() },
      body: form
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || "Erreur Whisper" });
    res.json({ text: data.text });
  } catch(e) {
    res.status(500).json({ error: "Erreur transcription : " + e.message });
  }
});

// ── AI Route (Groq — Llama 3.1 70B — 100% Gratuit) ──
app.post("/api/ai", auth, async (req, res) => {
  const { messages } = req.body;
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Clé API Groq non configurée. Créez un compte gratuit sur groq.com" });
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: "Messages invalides" });

  const system = {
    role: "system",
    content: `Tu es un assistant juridique expert spécialisé dans le droit marocain au service du cabinet GESTION JURIDIQUE.
Tu maîtrises : le DOC (Dahir des Obligations et Contrats), le Code du Travail (Loi 65-99),
le Code de Commerce (Loi 15-95), le Code Pénal marocain, le Code de Procédure Civile,
le droit de la famille marocain (Moudawwana), le droit immobilier, la fiscalité (CGI),
les procédures devant le TPI, la Cour d appel et la Cour Suprême.
Tu peux rédiger des actes, analyser des contrats, citer des articles de loi,
calculer des délais procéduraux et préparer des consultations.
Réponds toujours en français, de façon professionnelle et structurée.
Cite les articles de loi marocains pertinents quand c est possible.`
  };

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [system, ...messages],
        max_tokens: 2000,
        temperature: 0.3
      })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || "Erreur Groq" });
    res.json({ reply: data.choices[0].message.content, usage: data.usage });
  } catch (e) {
    res.status(500).json({ error: "Erreur de connexion à Groq" });
  }
});


// ── Direct subscription extension (like Madrasati/PayMaroc/ERP) ──
app.post("/api/admin/extend", auth, superOnly, (req, res) => {
  const { userId, days } = req.body;
  const users = loadJSON(USERS_FILE, []);
  const user = users.find(u => u.id === parseInt(userId));
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable" });

  // Generate and assign a new licence key
  const licences = loadJSON(LICENCES_FILE, []);
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const seg = () => Array.from({length:5}, () => chars[Math.floor(Math.random()*chars.length)]).join("");
  const key = `LEXIA-${seg()}-${seg()}-AUTO`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + days * 86400000).toISOString();
  const lic = { key, plan: days === 30 ? "monthly" : "yearly", createdAt: now.toISOString(), expiresAt, usedBy: user.email, activatedAt: now.toISOString() };
  licences.push(lic);
  saveJSON(LICENCES_FILE, licences);
  user.licenceKey = key;
  saveJSON(USERS_FILE, users);
  res.json({ ok: true, expiresAt, licence: checkLicence(user) });
});

app.post("/api/admin/lifetime", auth, superOnly, (req, res) => {
  const { userId } = req.body;
  const users = loadJSON(USERS_FILE, []);
  const user = users.find(u => u.id === parseInt(userId));
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable" });

  const licences = loadJSON(LICENCES_FILE, []);
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const seg = () => Array.from({length:5}, () => chars[Math.floor(Math.random()*chars.length)]).join("");
  const key = `LEXIA-${seg()}-${seg()}-VIE`;
  const now = new Date();
  const lic = { key, plan: "lifetime", createdAt: now.toISOString(), expiresAt: null, usedBy: user.email, activatedAt: now.toISOString() };
  licences.push(lic);
  saveJSON(LICENCES_FILE, licences);
  user.licenceKey = key;
  saveJSON(USERS_FILE, users);
  res.json({ ok: true, licence: checkLicence(user) });
});

// Admin assign licence directly to user
app.post("/api/admin/assign-licence", auth, superOnly, (req, res) => {
  const { userId, licenceKey } = req.body;
  const users = loadJSON(USERS_FILE, []);
  const user = users.find(u => u.id === parseInt(userId));
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable" });
  const licences = loadJSON(LICENCES_FILE, []);
  const lic = licences.find(l => l.key === licenceKey);
  if (!lic) return res.status(404).json({ error: "Clé introuvable" });
  lic.usedBy = user.email;
  lic.activatedAt = new Date().toISOString();
  saveJSON(LICENCES_FILE, licences);
  user.licenceKey = licenceKey;
  saveJSON(USERS_FILE, users);
  res.json({ ok: true, licence: checkLicence(user) });
});

// ── Serve app ──
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/admin.html"));
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

initUsers();
app.listen(PORT, () => console.log(`✦ LEXIA Server port ${PORT}`));
