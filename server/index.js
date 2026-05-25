const express = require("express");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3001;

app.get("/health", (req, res) => res.json({status:"ok"}));
app.use(express.static(path.join(__dirname, "../public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

app.listen(PORT, () => console.log("Cabinet Juridique Maroc - port " + PORT));
