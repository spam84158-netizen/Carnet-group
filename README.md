# Le Carnet — déploiement sur Render

## Structure
- `server.js` — le petit serveur qui garde les inscriptions
- `data/members.json` — là où les inscriptions sont enregistrées
- `public/index.html` — le site (le même que tu avais, mais qui parle maintenant au serveur)

## Déployer sur Render
1. Mets ce dossier entier dans un repo Git (GitHub, GitLab...) ou upload-le directement si Render te le permet.
2. Sur Render : **New +** → **Web Service**.
3. Connecte le repo.
4. Configuration :
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Instance Type** : Free (suffisant pour un groupe d'amis)
5. Déploie. Ton lien sera du style `https://ton-nom.onrender.com`.

## Important à savoir
- Sur le plan gratuit de Render, le fichier `data/members.json` peut être remis à zéro si tu **redéploies** le service (nouveau push Git) ou si Render change d'instance. Tant que tu ne redéploies pas, les inscriptions restent.
- Si tu veux une vraie garantie que rien ne se perde même après un redéploiement, il faudrait ajouter un **disque persistant** (payant sur Render) ou une petite base de données. Dis-le moi si tu veux qu'on passe à ça plus tard.
- Avant de partager le lien : ouvre `public/index.html`, cherche le bloc `CONFIG` en haut du `<script>`, et remplis `GROUP_NAME`, `GROUP_JOIN_LINK` et `VERIFIED_FULL_NAMES`.

## Tester en local (optionnel)
```
npm install
npm start
```
Puis ouvre `http://localhost:3000`.
