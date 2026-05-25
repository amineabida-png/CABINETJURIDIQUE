# LEXIA — Cabinet Juridique

Application de gestion pour cabinet d'avocats et de notaires avec assistant IA juridique intégré.

## 🚀 Déploiement sur Railway

### 1. Prérequis
- Compte [Railway](https://railway.app)
- Compte [Anthropic](https://console.anthropic.com) avec clé API
- Git installé

### 2. Déployer en 5 étapes

```bash
# 1. Initialise le repo Git
cd cabinet-juridique
git init
git add .
git commit -m "Initial commit — LEXIA Cabinet Juridique"

# 2. Crée un repo sur GitHub et pousse
git remote add origin https://github.com/TON_USER/cabinet-juridique.git
git push -u origin main
```

**Sur railway.app :**
1. Clique **"New Project"**
2. Choisis **"Deploy from GitHub repo"**
3. Sélectionne ton repo `cabinet-juridique`
4. Railway détecte automatiquement la config

### 3. Variable d'environnement (OBLIGATOIRE)

Dans Railway → ton projet → **Variables** :

| Variable | Valeur |
|----------|--------|
| `ANTHROPIC_API_KEY` | `sk-ant-xxxxx...` |

Railway définit `PORT` automatiquement — ne pas le toucher.

### 4. C'est tout !

Railway va :
- Exécuter `npm run build` (installe et compile le front React)
- Démarrer `npm start` (lance le serveur Express)
- Générer une URL publique `https://xxx.up.railway.app`

## 🏗 Architecture

```
cabinet-juridique/
├── server/
│   └── index.js          # Serveur Express + proxy IA sécurisé
├── client/
│   ├── src/
│   │   ├── main.jsx      # Point d'entrée React
│   │   └── App.jsx       # Application complète LEXIA
│   ├── index.html
│   ├── vite.config.js
│   └── package.json
├── railway.json           # Config Railway
├── package.json           # Scripts build/start
└── .env.example           # Variables d'environnement
```

## 💻 Développement local

```bash
# Installe toutes les dépendances
npm run install:all

# Copie et configure les variables
cp .env.example .env
# Édite .env avec ta clé Anthropic

# Lance le dev (backend + frontend en parallèle)
npm run dev
```

- Frontend : http://localhost:5173
- Backend : http://localhost:3001
- Health check : http://localhost:3001/health

## 🔒 Sécurité

- Clé API **jamais exposée** côté client
- Rate limiting : 30 requêtes IA/minute/IP
- Helmet.js pour les headers HTTP
- Validation des inputs côté serveur

## 📦 Modules inclus

| Module | Description |
|--------|-------------|
| Tableau de bord | KPIs, agenda, accès rapide IA |
| Clients & Dossiers | Gestion complète des dossiers avocat/notaire |
| Agenda | Planning journalier et hebdomadaire |
| Actes & Documents | Registre et génération IA |
| Honoraires | Facturation et suivi paiements |
| Suivi procédures | Instances judiciaires et chronologie |
| Bibliothèque juridique | Codes, textes, jurisprudence |
| Collaborateurs & RH | Équipe, congés, formations |
| Comptabilité | Charges, CARPA, prévisionnel |
| Conformité LCB-FT | Anti-blanchiment, RGPD, conflits |
| Portail client | Messagerie sécurisée, documents |
| Assistant LEXIA IA | Chat juridique propulsé par Claude |
