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
      ts BIGINT,
      referred_by TEXT,
      videos_count INTEGER DEFAULT 0,
      likes_count INTEGER DEFAULT 0
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id TEXT PRIMARY KEY,
      member_id TEXT,
      amount INTEGER,
      status TEXT DEFAULT 'pending',
      ts BIGINT
    );
  `);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS referred_by TEXT;`);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS videos_count INTEGER DEFAULT 0;`);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS likes_count INTEGER DEFAULT 0;`);
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
    ts: Number(r.ts),
    referredBy: r.referred_by,
    videosCount: r.videos_count || 0,
    likesCount: r.likes_count || 0,
    referralCount: Number(r.referral_count || 0)
  };
}

async function getAllMembers(){
  const result = await pool.query(`
    SELECT m.*, (SELECT COUNT(*) FROM members r WHERE r.referred_by = m.id) AS referral_count
    FROM members m
    ORDER BY passenger_no ASC
  `);
  return result.rows.map(rowToMember);
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/members', async (req, res) => {
  res.json(await getAllMembers());
});

app.post('/api/members', async (req, res) => {
  const { prenom, nom, age, ville, situation, phone, photo, verified, referredBy } = req.body || {};
  if(!prenom || !nom || !age || !ville || !phone || !photo){
    return res.status(400).json({ error: 'Champs manquants.' });
  }

  const countRes = await pool.query('SELECT COUNT(*) FROM members');
  const passengerNo = parseInt(countRes.rows[0].count, 10) + 1;
  const id = 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const ts = Date.now();

  await pool.query(
    `INSERT INTO members (id, passenger_no, prenom, nom, age, ville, situation, phone, photo, verified, followers, ts, referred_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'[]',$11,$12)`,
    [id, passengerNo, prenom, nom, age, ville, situation, phone, photo, !!verified, ts, referredBy || null]
  );

  const members = await getAllMembers();
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
  res.json({ members: await getAllMembers() });
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
  res.json({ members: await getAllMembers() });
});

const MAX_WITHDRAWAL = 50000;

// Un membre demande un retrait (montant plafonné, statut "pending" jusqu'à validation manuelle)
app.post('/api/withdrawals', async (req, res) => {
  const { memberId, amount } = req.body || {};
  const amt = parseInt(amount, 10);
  if(!memberId || !amt || amt <= 0 || amt > MAX_WITHDRAWAL){
    return res.status(400).json({ error: 'Montant invalide (max ' + MAX_WITHDRAWAL + ' F).' });
  }
  const memberRes = await pool.query('SELECT * FROM members WHERE id=$1', [memberId]);
  if(!memberRes.rows[0]) return res.status(404).json({ error: 'Membre introuvable.' });

  const id = 'w_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  await pool.query(
    `INSERT INTO withdrawals (id, member_id, amount, status, ts) VALUES ($1,$2,$3,'pending',$4)`,
    [id, memberId, amt, Date.now()]
  );
  res.json({ ok: true });
});

// Liste des demandes en attente — uniquement visible par un compte certifié
app.get('/api/withdrawals', async (req, res) => {
  const { requesterId } = req.query;
  const reqRes = await pool.query('SELECT * FROM members WHERE id=$1', [requesterId]);
  const requester = reqRes.rows[0];
  if(!requester || !requester.verified){
    return res.status(403).json({ error: 'Non autorisé.' });
  }
  const result = await pool.query(`
    SELECT w.*, m.prenom, m.nom, m.phone,
      (SELECT COUNT(*) FROM members r WHERE r.referred_by = m.id) AS referral_count,
      m.videos_count, m.likes_count
    FROM withdrawals w
    JOIN members m ON m.id = w.member_id
    WHERE w.status = 'pending'
    ORDER BY w.ts ASC
  `);
  res.json(result.rows.map(r => ({
    id: r.id,
    memberId: r.member_id,
    prenom: r.prenom,
    nom: r.nom,
    phone: r.phone,
    amount: r.amount,
    referralCount: Number(r.referral_count),
    videosCount: r.videos_count,
    likesCount: r.likes_count,
    ts: Number(r.ts)
  })));
});

// Marquer une demande comme payée — uniquement par un compte certifié
app.post('/api/withdrawals/:id/pay', async (req, res) => {
  const { requesterId } = req.body || {};
  const reqRes = await pool.query('SELECT * FROM members WHERE id=$1', [requesterId]);
  const requester = reqRes.rows[0];
  if(!requester || !requester.verified){
    return res.status(403).json({ error: 'Non autorisé.' });
  }
  await pool.query(`UPDATE withdrawals SET status='paid' WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`Le carnet tourne sur le port ${PORT}`));
}).catch(err => {
  console.error('Erreur de connexion à la base de données', err);
});
