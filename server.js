const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// L'adresse de connexion vient de Neon, réglée dans Render (variable d'environnement DATABASE_URL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      passenger_no INTEGER,
      prenom TEXT,
      nom TEXT,
      age TEXT,
      ville TEXT,
      situation TEXT,
      phone TEXT,
      photo TEXT,
      verified BOOLEAN DEFAULT false,
      followers JSONB DEFAULT '[]',
      ts BIGINT
    );
  `);
}

function rowToMember(r){
  return {
    id: r.id,
    passengerNo: r.passenger_no,
    prenom: r.prenom,
    nom: r.nom,
    age: r.age,
    ville: r.ville,
    situation: r.situation,
    phone: r.phone,
    photo: r.photo,
    verified: r.verified,
    followers: r.followers || [],
    ts: Number(r.ts)
  };
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/members', async (req, res) => {
  const result = await pool.query('SELECT * FROM members ORDER BY passenger_no ASC');
  res.json(result.rows.map(rowToMember));
});

app.post('/api/members', async (req, res) => {
  const { prenom, nom, age, ville, situation, phone, photo, verified } = req.body || {};
  if(!prenom || !nom || !age || !ville || !phone || !photo){
    return res.status(400).json({ error: 'Champs manquants.' });
  }

  const countRes = await pool.query('SELECT COUNT(*) FROM members');
  const passengerNo = parseInt(countRes.rows[0].count, 10) + 1;
  const id = 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const ts = Date.now();

  await pool.query(
    `INSERT INTO members (id, passenger_no, prenom, nom, age, ville, situation, phone, photo, verified, followers, ts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'[]',$11)`,
    [id, passengerNo, prenom, nom, age, ville, situation, phone, photo, !!verified, ts]
  );

  const allRes = await pool.query('SELECT * FROM members ORDER BY passenger_no ASC');
  const members = allRes.rows.map(rowToMember);
  res.json({ member: members.find(m => m.id === id), members });
});

app.post('/api/members/:id/verify', async (req, res) => {
  const { requesterId } = req.body || {};
  const reqRes = await pool.query('SELECT * FROM members WHERE id=$1', [requesterId]);
  const requester = reqRes.rows[0];
  if(!requester || !requester.verified){
    return res.status(403).json({ error: 'Non autorisé.' });
  }
  await pool.query('UPDATE members SET verified=true WHERE id=$1', [req.params.id]);
  const allRes = await pool.query('SELECT * FROM members ORDER BY passenger_no ASC');
  res.json({ members: allRes.rows.map(rowToMember) });
});

app.post('/api/members/:id/follow', async (req, res) => {
  const { followerId } = req.body || {};
  if(!followerId || followerId === req.params.id){
    return res.status(400).json({ error: 'Requête invalide.' });
  }
  const targetRes = await pool.query('SELECT * FROM members WHERE id=$1', [req.params.id]);
  const target = targetRes.rows[0];
  if(!target) return res.status(404).json({ error: 'Membre introuvable.' });

  let followers = target.followers || [];
  if(followers.includes(followerId)){
    followers = followers.filter(f => f !== followerId);
  } else {
    followers.push(followerId);
  }
  await pool.query('UPDATE members SET followers=$1 WHERE id=$2', [JSON.stringify(followers), req.params.id]);
  const allRes = await pool.query('SELECT * FROM members ORDER BY passenger_no ASC');
  res.json({ members: allRes.rows.map(rowToMember) });
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`Le carnet tourne sur le port ${PORT}`));
}).catch(err => {
  console.error('Erreur de connexion à la base de données', err);
});
