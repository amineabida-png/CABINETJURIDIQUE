require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "Cabinet Juridique Maroc", timestamp: new Date().toISOString() });
});

// Serve static HTML directly - no build needed
app.use(express.static(path.join(__dirname, "../public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

app.listen(PORT, () => {
  console.log(`Cabinet Juridique Maroc démarré sur le port ${PORT}`);
});
