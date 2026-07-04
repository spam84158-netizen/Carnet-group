const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'members.json');

app.use(express.json({ limit: '10mb' })); // limite large car les photos sont en base64
app.use(express.static(path.join(__dirname, 'public')));

function readMembers(){
  try{
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  }catch(e){
    return [];
  }
}

function writeMembers(members){
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(members, null, 2));
}

// Récupérer tous les membres
app.get('/api/members', (req, res) => {
  res.json(readMembers());
});

// Ajouter un membre
app.post('/api/members', (req, res) => {
  const body = req.body || {};
  const { prenom, nom, age, ville, situation, phone, photo, verified } = body;

  if(!prenom || !nom || !age || !ville || !phone || !photo){
    return res.status(400).json({ error: 'Champs manquants.' });
  }

  const members = readMembers();

  const member = {
    id: 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    passengerNo: members.length + 1,
    prenom, nom, age, ville, situation, phone, photo,
    verified: !!verified,
    ts: Date.now()
  };

  members.push(member);
  writeMembers(members);

  res.json({ member, members });
});

app.listen(PORT, () => {
  console.log(`Le carnet tourne sur le port ${PORT}`);
});
