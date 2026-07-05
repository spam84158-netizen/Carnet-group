const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { Pool } = require('pg');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const PORT = process.env.PORT || 3000;

// Binaire ffmpeg fourni par le package (aucune installation système requise sur Render)
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;

// Stockage des fichiers vidéo sur Cloudflare R2 — Neon reste léger (texte uniquement)
const r2Configured = !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET_NAME && process.env.R2_PUBLIC_URL);
const r2Client = r2Configured ? new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
}) : null;

async function uploadVideoToR2(filePath, key){
  const body = fs.readFileSync(filePath);
  await r2Client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: 'video/mp4'
  }));
  const base = process.env.R2_PUBLIC_URL.replace(/\/$/, '');
  return `${base}/${key}`;
}

function run(bin, args){
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if(err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

async function probeVideo(filePath){
  const out = await run(ffprobePath, [
    '-v', 'error', '-print_format', 'json',
    '-show_streams', '-show_format', filePath
  ]);
  return JSON.parse(out);
}

// Incruste un filigrane discret sur toute la vidéo + un outro animé et fun à la toute fin,
// pour que le filigrane reste visible même si la vidéo est téléchargée puis rouverte ailleurs.
async function addWatermarkAndOutro(inputPath, outputPath, authorLabel){
  const meta = await probeVideo(inputPath);
  const vStream = meta.streams.find(s => s.codec_type === 'video');
  const hasAudio = meta.streams.some(s => s.codec_type === 'audio');
  if(!vStream) throw new Error('Pas de flux vidéo détecté.');

  const width = vStream.width || 720;
  const height = vStream.height || 1280;
  let fps = 30;
  if(vStream.r_frame_rate && vStream.r_frame_rate.includes('/')){
    const [n, d] = vStream.r_frame_rate.split('/').map(Number);
    if(d) fps = Math.round(n / d) || 30;
  }

  const fontSize = Math.max(16, Math.round(width * 0.032));
  const bigFontSize = Math.max(30, Math.round(width * 0.095));
  const midFontSize = Math.max(18, Math.round(width * 0.05));
  const outroDuration = 2.3;
  const escapeText = t => t.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\u2019");

  const finalFilter = [
    // filigrane discret, présent sur toute la durée de la vidéo originale
    `[0:v]drawtext=text='${escapeText('🐾 Le Carnet')}':fontcolor=white@0.88:fontsize=${fontSize}:` +
      `x=w-tw-22:y=h-th-26:box=1:boxcolor=black@0.32:boxborderw=9[wm]`,
    // fond de l'outro, généré directement (pas besoin d'un fichier ou d'un 2e input)
    `color=c=0x0B0B0C:s=${width}x${height}:d=${outroDuration}:r=${fps}[bg]`,
    // texte principal qui explose en fondu
    `[bg]drawtext=text='${escapeText('💛 LE CARNET 🐾')}':fontcolor=0xE4C978:fontsize=${bigFontSize}:` +
      `x=(w-text_w)/2:y=(h-text_h)/2-${Math.round(bigFontSize*0.7)}:alpha='if(lt(t,0.9),t/0.9,1)'[o1]`,
    // nom de l'auteur, apparaît juste après
    `[o1]drawtext=text='${escapeText(authorLabel)}':fontcolor=white:fontsize=${midFontSize}:` +
      `x=(w-text_w)/2:y=(h-text_h)/2+${Math.round(bigFontSize*0.35)}:` +
      `alpha='if(lt(t,1.2),0,if(lt(t,1.7),(t-1.2)/0.5,1))'[o2]`,
    // accroche finale
    `[o2]drawtext=text='${escapeText('✨ Rejoins le cercle ✨')}':fontcolor=0xC9A24B:fontsize=${Math.round(midFontSize*0.85)}:` +
      `x=(w-text_w)/2:y=(h-text_h)/2+${Math.round(bigFontSize*1.15)}:` +
      `alpha='if(lt(t,1.7),0,if(lt(t,2.3),(t-1.7)/0.6,1))'[outro]`,
    // silence pour que l'outro ait une piste audio compatible avec la concaténation
    hasAudio ? `anullsrc=channel_layout=stereo:sample_rate=44100:d=${outroDuration}[silence]` : null,
    hasAudio
      ? `[wm][0:a][outro][silence]concat=n=2:v=1:a=1[outv][outa]`
      : `[wm][outro]concat=n=2:v=1:a=0[outv]`
  ].filter(Boolean).join(';');

  const args = [
    '-y',
    '-i', inputPath,
    '-filter_complex', finalFilter,
    '-map', '[outv]'
  ];
  if(hasAudio) args.push('-map', '[outa]');
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-movflags', '+faststart',
    outputPath
  );

  await run(ffmpegPath, args);
}

// Retourne { videoData, link } : videoData=null + link=URL R2 en cas de succès,
// ou videoData=base64 + link=null en secours si R2 n'est pas configuré / échoue.
async function processUploadedVideo(dataUrl, authorLabel, videoId){
  const match = /^data:video\/[a-zA-Z0-9.+-]+;base64,(.+)$/.exec(dataUrl);
  if(!match) return { videoData: dataUrl, link: null }; // format inattendu, on republie tel quel plutôt que de bloquer

  const tmpDir = os.tmpdir();
  const token = crypto.randomBytes(6).toString('hex');
  const inputPath = path.join(tmpDir, `in_${token}.mp4`);
  const outputPath = path.join(tmpDir, `out_${token}.mp4`);

  try{
    fs.writeFileSync(inputPath, Buffer.from(match[1], 'base64'));
    await addWatermarkAndOutro(inputPath, outputPath, authorLabel);

    if(r2Configured){
      try{
        const url = await uploadVideoToR2(outputPath, `videos/${videoId}.mp4`);
        return { videoData: null, link: url };
      }catch(uploadErr){
        console.error('Upload R2 échoué, stockage en base64 en secours :', uploadErr.message);
      }
    }
    // Pas de R2 configuré (ou upload échoué) : on stocke en base64 pour ne pas bloquer la publication
    const processed = fs.readFileSync(outputPath);
    return { videoData: 'data:video/mp4;base64,' + processed.toString('base64'), link: null };
  }catch(err){
    console.error('Filigrane échoué, publication de la vidéo brute :', err.message);
    return { videoData: dataUrl, link: null };
  }finally{
    [inputPath, outputPath].forEach(p => { try{ fs.unlinkSync(p); }catch(e){} });
  }
}

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      author_id TEXT,
      video_data TEXT,
      link TEXT,
      description TEXT,
      likes JSONB DEFAULT '[]',
      comments JSONB DEFAULT '[]',
      ts BIGINT
    );
  `);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS referred_by TEXT;`);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS videos_count INTEGER DEFAULT 0;`);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS likes_count INTEGER DEFAULT 0;`);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS group_proof_photo TEXT;`);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS group_proof_status TEXT DEFAULT 'none';`);
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS favorites JSONB DEFAULT '[]';`);
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS reposts JSONB DEFAULT '[]';`);
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
    referralCount: Number(r.referral_count || 0),
    groupProofPhoto: r.group_proof_photo || null,
    groupProofStatus: r.group_proof_status || 'none'
  };
}

function rowToVideo(r){
  return {
    id: r.id,
    authorId: r.author_id,
    videoData: r.video_data,
    link: r.link,
    desc: r.description,
    likes: r.likes || [],
    comments: r.comments || [],
    favorites: r.favorites || [],
    reposts: r.reposts || [],
    ts: Number(r.ts)
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

async function getAllVideos(){
  const result = await pool.query(`SELECT * FROM videos ORDER BY ts ASC`);
  return result.rows.map(rowToVideo);
}

// Recalcule le total de likes reçus par un membre sur toutes ses vidéos
async function recomputeLikesCount(authorId){
  if(!authorId) return;
  await pool.query(`
    UPDATE members SET likes_count = (
      SELECT COALESCE(SUM(jsonb_array_length(likes)), 0) FROM videos WHERE author_id = $1
    ) WHERE id = $1
  `, [authorId]);
}

// Vidéos en base64 : la requête JSON peut peser plusieurs dizaines de Mo
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ================== MEMBRES ================== */

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

/* ================== PREUVE D'AJOUT AU GROUPE WHATSAPP ================== */

// Un membre envoie sa capture d'écran, le statut repasse à "pending"
app.post('/api/members/:id/group-proof', async (req, res) => {
  const { photo } = req.body || {};
  if(!photo){
    return res.status(400).json({ error: 'Photo manquante.' });
  }
  const memberRes = await pool.query('SELECT * FROM members WHERE id=$1', [req.params.id]);
  if(!memberRes.rows[0]) return res.status(404).json({ error: 'Membre introuvable.' });

  await pool.query(
    `UPDATE members SET group_proof_photo=$1, group_proof_status='pending' WHERE id=$2`,
    [photo, req.params.id]
  );
  res.json({ members: await getAllMembers() });
});

// Liste des preuves en attente — uniquement visible par un compte certifié
app.get('/api/group-proofs', async (req, res) => {
  const { requesterId } = req.query;
  const reqRes = await pool.query('SELECT * FROM members WHERE id=$1', [requesterId]);
  const requester = reqRes.rows[0];
  if(!requester || !requester.verified){
    return res.status(403).json({ error: 'Non autorisé.' });
  }
  const result = await pool.query(
    `SELECT id, prenom, nom, group_proof_photo FROM members WHERE group_proof_status='pending' ORDER BY ts ASC`
  );
  res.json(result.rows.map(r => ({
    id: r.id,
    prenom: r.prenom,
    nom: r.nom,
    photo: r.group_proof_photo
  })));
});

// Valider ou refuser une preuve — uniquement par un compte certifié
app.post('/api/members/:id/group-proof/review', async (req, res) => {
  const { requesterId, approve } = req.body || {};
  const reqRes = await pool.query('SELECT * FROM members WHERE id=$1', [requesterId]);
  const requester = reqRes.rows[0];
  if(!requester || !requester.verified){
    return res.status(403).json({ error: 'Non autorisé.' });
  }
  await pool.query(
    `UPDATE members SET group_proof_status=$1 WHERE id=$2`,
    [approve ? 'approved' : 'rejected', req.params.id]
  );
  res.json({ members: await getAllMembers() });
});

/* ================== VIDEOS ================== */

app.get('/api/videos', async (req, res) => {
  res.json(await getAllVideos());
});

app.post('/api/videos', async (req, res) => {
  const { authorId, videoData, link, desc } = req.body || {};
  if(!authorId || (!videoData && !link)){
    return res.status(400).json({ error: 'Vidéo manquante.' });
  }
  const authorRes = await pool.query('SELECT * FROM members WHERE id=$1', [authorId]);
  const author = authorRes.rows[0];
  if(!author) return res.status(404).json({ error: 'Membre introuvable.' });

  const id = 'v_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const ts = Date.now();

  // Incrustation du filigrane + outro, puis upload sur R2 (Neon ne stocke que du texte)
  let finalVideoData = null;
  let finalLink = link || null;
  if(videoData){
    const result = await processUploadedVideo(videoData, '@' + author.prenom + ' ' + author.nom, id);
    finalVideoData = result.videoData;
    finalLink = result.link || finalLink;
  }

  await pool.query(
    `INSERT INTO videos (id, author_id, video_data, link, description, likes, comments, ts)
     VALUES ($1,$2,$3,$4,$5,'[]','[]',$6)`,
    [id, authorId, finalVideoData, finalLink, desc || '', ts]
  );
  await pool.query('UPDATE members SET videos_count = videos_count + 1 WHERE id=$1', [authorId]);

  res.json({ videos: await getAllVideos() });
});

app.post('/api/videos/:id/like', async (req, res) => {
  const { memberId } = req.body || {};
  if(!memberId){
    return res.status(400).json({ error: 'Requête invalide.' });
  }
  const videoRes = await pool.query('SELECT * FROM videos WHERE id=$1', [req.params.id]);
  const video = videoRes.rows[0];
  if(!video) return res.status(404).json({ error: 'Vidéo introuvable.' });

  let likes = video.likes || [];
  if(likes.includes(memberId)){
    likes = likes.filter(l => l !== memberId);
  } else {
    likes.push(memberId);
  }
  await pool.query('UPDATE videos SET likes=$1 WHERE id=$2', [JSON.stringify(likes), req.params.id]);
  await recomputeLikesCount(video.author_id);

  res.json({ videos: await getAllVideos() });
});

app.post('/api/videos/:id/comment', async (req, res) => {
  const { memberId, authorName, text } = req.body || {};
  const trimmed = (text || '').trim();
  if(!memberId || !trimmed){
    return res.status(400).json({ error: 'Commentaire vide.' });
  }
  const videoRes = await pool.query('SELECT * FROM videos WHERE id=$1', [req.params.id]);
  const video = videoRes.rows[0];
  if(!video) return res.status(404).json({ error: 'Vidéo introuvable.' });

  const commentId = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const comments = video.comments || [];
  comments.push({ id: commentId, memberId, authorName: authorName || 'Membre', text: trimmed, ts: Date.now() });
  await pool.query('UPDATE videos SET comments=$1 WHERE id=$2', [JSON.stringify(comments), req.params.id]);

  res.json({ videos: await getAllVideos() });
});

// Suppression d'un commentaire — uniquement par son auteur
app.delete('/api/videos/:id/comment/:commentId', async (req, res) => {
  const { requesterId } = req.body || {};
  const videoRes = await pool.query('SELECT * FROM videos WHERE id=$1', [req.params.id]);
  const video = videoRes.rows[0];
  if(!video) return res.status(404).json({ error: 'Vidéo introuvable.' });

  const comments = video.comments || [];
  const target = comments.find(c => c.id === req.params.commentId);
  if(!target) return res.status(404).json({ error: 'Commentaire introuvable.' });
  if(target.memberId !== requesterId){
    return res.status(403).json({ error: 'Tu ne peux supprimer que tes propres commentaires.' });
  }
  const updated = comments.filter(c => c.id !== req.params.commentId);
  await pool.query('UPDATE videos SET comments=$1 WHERE id=$2', [JSON.stringify(updated), req.params.id]);

  res.json({ videos: await getAllVideos() });
});

app.post('/api/videos/:id/favorite', async (req, res) => {
  const { memberId } = req.body || {};
  if(!memberId) return res.status(400).json({ error: 'Requête invalide.' });

  const videoRes = await pool.query('SELECT * FROM videos WHERE id=$1', [req.params.id]);
  const video = videoRes.rows[0];
  if(!video) return res.status(404).json({ error: 'Vidéo introuvable.' });

  let favorites = video.favorites || [];
  if(favorites.includes(memberId)){
    favorites = favorites.filter(f => f !== memberId);
  } else {
    favorites.push(memberId);
  }
  await pool.query('UPDATE videos SET favorites=$1 WHERE id=$2', [JSON.stringify(favorites), req.params.id]);
  res.json({ videos: await getAllVideos() });
});

app.post('/api/videos/:id/repost', async (req, res) => {
  const { memberId } = req.body || {};
  if(!memberId) return res.status(400).json({ error: 'Requête invalide.' });

  const videoRes = await pool.query('SELECT * FROM videos WHERE id=$1', [req.params.id]);
  const video = videoRes.rows[0];
  if(!video) return res.status(404).json({ error: 'Vidéo introuvable.' });

  let reposts = video.reposts || [];
  if(reposts.includes(memberId)){
    reposts = reposts.filter(r => r !== memberId);
  } else {
    reposts.push(memberId);
  }
  await pool.query('UPDATE videos SET reposts=$1 WHERE id=$2', [JSON.stringify(reposts), req.params.id]);
  res.json({ videos: await getAllVideos() });
});

// Suppression — uniquement par l'auteur de la vidéo
app.delete('/api/videos/:id', async (req, res) => {
  const { requesterId } = req.body || {};
  const videoRes = await pool.query('SELECT * FROM videos WHERE id=$1', [req.params.id]);
  const video = videoRes.rows[0];
  if(!video) return res.status(404).json({ error: 'Vidéo introuvable.' });
  if(video.author_id !== requesterId){
    return res.status(403).json({ error: 'Tu ne peux supprimer que tes propres vidéos.' });
  }
  if(r2Configured && !video.video_data && video.link && video.link.includes(process.env.R2_PUBLIC_URL)){
    try{
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      await r2Client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: `videos/${req.params.id}.mp4` }));
    }catch(e){ console.error('Suppression R2 échouée (non bloquant) :', e.message); }
  }
  await pool.query('DELETE FROM videos WHERE id=$1', [req.params.id]);
  await pool.query('UPDATE members SET videos_count = GREATEST(videos_count - 1, 0) WHERE id=$1', [requesterId]);
  await recomputeLikesCount(requesterId);
  res.json({ videos: await getAllVideos() });
});

// Lien direct vers le fichier vidéo (pour "copier le lien" et le partage réel)
app.get('/api/videos/:id/raw', async (req, res) => {
  const videoRes = await pool.query('SELECT video_data, link FROM videos WHERE id=$1', [req.params.id]);
  const video = videoRes.rows[0];
  if(!video) return res.status(404).send('Introuvable.');
  if(!video.video_data){
    if(video.link) return res.redirect(video.link);
    return res.status(404).send('Introuvable.');
  }
  const match = /^data:(video\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(video.video_data);
  if(!match) return res.status(500).send('Format vidéo invalide.');
  const mimeType = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  res.set('Content-Type', mimeType);
  res.set('Cache-Control', 'public, max-age=31536000');
  res.send(buffer);
});

/* ================== RETRAITS ================== */

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
