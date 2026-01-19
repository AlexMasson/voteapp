require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Redis } = require('@upstash/redis');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Connexion Redis Upstash
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Servir les fichiers statiques
app.use(express.static(path.join(__dirname, 'public')));

// Route keep-alive pour éviter que Render s'endorme
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// Préfixe pour les clés Redis
const PARTY_PREFIX = 'party:';
const USER_PREFIX = 'user:';

// TTL des parties (2 heures)
const PARTY_TTL = 7200;

// Structure d'une partie (stockée en JSON dans Redis) :
// {
//   code: string,
//   recepteurId: string,
//   etat: 'OUVERTE' | 'FERMEE' | 'VOTE_OUVERT' | 'VOTE_FERME',
//   emetteurs: { [socketId]: { id: string, nom: string } },
//   votes: { [socketId]: number },
//   moyenne: number | null,
//   historique: Array<{ numero: number, moyenne: number, nbVotants: number, votes: Object }>,
//   timer: number | null,
//   timerEndTime: number | null (timestamp)
// }

// Cache local pour les timers (ne peut pas être dans Redis)
const timerIntervals = new Map();

// Génère un code à 4 chiffres unique
async function generateCode() {
  let code;
  let exists = true;
  while (exists) {
    code = Math.floor(1000 + Math.random() * 9000).toString();
    exists = await redis.exists(PARTY_PREFIX + code);
  }
  return code;
}

// Récupérer une partie depuis Redis
async function getParty(code) {
  if (!code) return null;
  const data = await redis.get(PARTY_PREFIX + code);
  return data;
}

// Sauvegarder une partie dans Redis
async function saveParty(party) {
  await redis.set(PARTY_PREFIX + party.code, party, { ex: PARTY_TTL });
}

// Supprimer une partie
async function deleteParty(code) {
  stopTimer(code);
  await redis.del(PARTY_PREFIX + code);
}

// Récupérer le code de partie d'un utilisateur
async function getUserParty(socketId) {
  return await redis.get(USER_PREFIX + socketId);
}

// Associer un utilisateur à une partie
async function setUserParty(socketId, code) {
  await redis.set(USER_PREFIX + socketId, code, { ex: PARTY_TTL });
}

// Supprimer l'association utilisateur -> partie
async function deleteUserParty(socketId) {
  await redis.del(USER_PREFIX + socketId);
}

function getPartyState(party) {
  if (!party) return null;

  // Liste des émetteurs avec leur statut de vote
  const emetteursList = [];
  for (const [id, data] of Object.entries(party.emetteurs || {})) {
    emetteursList.push({
      id: id,
      nom: data.nom,
      aVote: party.votes && party.votes[id] !== undefined
    });
  }

  // Calculer le timer restant si timerEndTime est défini
  let timer = null;
  if (party.timerEndTime) {
    timer = Math.max(0, Math.round((party.timerEndTime - Date.now()) / 1000));
    if (timer <= 0) timer = null;
  }

  return {
    code: party.code,
    etat: party.etat,
    nbEmetteurs: Object.keys(party.emetteurs || {}).length,
    moyenne: party.moyenne,
    emetteurs: emetteursList,
    nbVotes: Object.keys(party.votes || {}).length,
    historique: party.historique || [],
    timer: timer
  };
}

async function broadcastToParty(party) {
  const state = getPartyState(party);
  // Envoyer au récepteur
  io.to(party.recepteurId).emit('party-state', state);
  // Envoyer à tous les émetteurs
  for (const socketId of Object.keys(party.emetteurs || {})) {
    io.to(socketId).emit('party-state', state);
  }
}

function stopTimer(code) {
  if (timerIntervals.has(code)) {
    clearInterval(timerIntervals.get(code));
    timerIntervals.delete(code);
  }
}

function startTimer(party, seconds) {
  stopTimer(party.code);
  party.timerEndTime = Date.now() + seconds * 1000;

  const interval = setInterval(async () => {
    const currentParty = await getParty(party.code);
    if (!currentParty) {
      stopTimer(party.code);
      return;
    }

    const remaining = Math.round((currentParty.timerEndTime - Date.now()) / 1000);

    if (remaining <= 0) {
      stopTimer(party.code);
      await closeVote(currentParty);
    } else {
      // Broadcast pour mettre à jour le timer côté client
      await broadcastToParty(currentParty);
    }
  }, 1000);

  timerIntervals.set(party.code, interval);
}

async function closeVote(party) {
  party.etat = 'VOTE_FERME';
  party.timerEndTime = null;
  stopTimer(party.code);

  // Calculer la moyenne
  const votes = Object.values(party.votes || {});
  if (votes.length > 0) {
    const somme = votes.reduce((acc, v) => acc + v, 0);
    party.moyenne = Math.round((somme / votes.length) * 10) / 10;

    // Ajouter à l'historique
    const votesDetail = {};
    for (const [socketId, valeur] of Object.entries(party.votes || {})) {
      const emetteur = party.emetteurs[socketId];
      if (emetteur) {
        votesDetail[emetteur.nom] = valeur;
      }
    }

    party.historique = party.historique || [];
    party.historique.push({
      numero: party.historique.length + 1,
      moyenne: party.moyenne,
      nbVotants: votes.length,
      votes: votesDetail
    });
  } else {
    party.moyenne = null;
  }

  await saveParty(party);
  await broadcastToParty(party);
  console.log('Vote fermé, moyenne:', party.moyenne);
}

io.on('connection', (socket) => {
  console.log('Utilisateur connecté:', socket.id);

  // Envoyer l'état initial
  socket.emit('party-state', null);
  socket.emit('role', null);

  // Démarrer une partie (devenir Récepteur)
  socket.on('start-party', async () => {
    try {
      // Vérifier que l'utilisateur n'est pas déjà dans une partie
      const existingCode = await getUserParty(socket.id);
      if (existingCode) {
        socket.emit('error', 'Vous êtes déjà dans une partie');
        return;
      }

      const code = await generateCode();
      const party = {
        code: code,
        recepteurId: socket.id,
        etat: 'OUVERTE',
        emetteurs: {},
        votes: {},
        moyenne: null,
        historique: [],
        timerEndTime: null
      };

      await saveParty(party);
      await setUserParty(socket.id, code);

      socket.emit('role', 'recepteur');
      socket.emit('party-code', code);
      await broadcastToParty(party);
      console.log('Partie créée:', code, 'par:', socket.id);
    } catch (err) {
      console.error('Erreur start-party:', err);
      socket.emit('error', 'Erreur serveur');
    }
  });

  // Rejoindre une partie avec un code (devenir Émetteur)
  socket.on('join-party', async ({ code, nom }) => {
    try {
      // Vérifier que l'utilisateur n'est pas déjà dans une partie
      const existingCode = await getUserParty(socket.id);
      if (existingCode) {
        socket.emit('error', 'Vous êtes déjà dans une partie');
        return;
      }

      const party = await getParty(code);
      if (!party) {
        socket.emit('error', 'Code invalide');
        return;
      }

      if (party.etat !== 'OUVERTE') {
        socket.emit('error', 'Les portes sont fermées');
        return;
      }

      if (Object.keys(party.emetteurs || {}).length >= 25) {
        socket.emit('error', 'Nombre maximum de participants atteint');
        return;
      }

      // Nettoyer le nom
      const nomClean = (nom || 'Anonyme').trim().substring(0, 20) || 'Anonyme';

      party.emetteurs = party.emetteurs || {};
      party.emetteurs[socket.id] = { id: socket.id, nom: nomClean };

      await saveParty(party);
      await setUserParty(socket.id, code);

      socket.emit('role', 'emetteur');
      await broadcastToParty(party);
      console.log('Émetteur rejoint:', socket.id, 'nom:', nomClean, 'partie:', code);
    } catch (err) {
      console.error('Erreur join-party:', err);
      socket.emit('error', 'Erreur serveur');
    }
  });

  // Fermer les portes (Récepteur uniquement)
  socket.on('close-doors', async () => {
    try {
      const code = await getUserParty(socket.id);
      const party = await getParty(code);

      if (!party || socket.id !== party.recepteurId) {
        socket.emit('error', 'Action non autorisée');
        return;
      }

      party.etat = 'FERMEE';
      await saveParty(party);
      await broadcastToParty(party);
      console.log('Portes fermées, partie:', code);
    } catch (err) {
      console.error('Erreur close-doors:', err);
      socket.emit('error', 'Erreur serveur');
    }
  });

  // Ouvrir le vote (Récepteur uniquement)
  socket.on('open-vote', async (timerSeconds) => {
    try {
      const code = await getUserParty(socket.id);
      const party = await getParty(code);

      if (!party || socket.id !== party.recepteurId) {
        socket.emit('error', 'Action non autorisée');
        return;
      }

      party.votes = {};
      party.moyenne = null;
      party.etat = 'VOTE_OUVERT';

      // Démarrer le timer si spécifié
      if (timerSeconds && timerSeconds > 0) {
        startTimer(party, timerSeconds);
      } else {
        party.timerEndTime = null;
      }

      await saveParty(party);
      await broadcastToParty(party);
      console.log('Vote ouvert, partie:', code, 'timer:', timerSeconds || 'aucun');
    } catch (err) {
      console.error('Erreur open-vote:', err);
      socket.emit('error', 'Erreur serveur');
    }
  });

  // Fermer le vote (Récepteur uniquement)
  socket.on('close-vote', async () => {
    try {
      const code = await getUserParty(socket.id);
      const party = await getParty(code);

      if (!party || socket.id !== party.recepteurId) {
        socket.emit('error', 'Action non autorisée');
        return;
      }

      await closeVote(party);
    } catch (err) {
      console.error('Erreur close-vote:', err);
      socket.emit('error', 'Erreur serveur');
    }
  });

  // Voter (Émetteur uniquement)
  socket.on('vote', async (valeur) => {
    try {
      const code = await getUserParty(socket.id);
      const party = await getParty(code);

      if (!party) {
        socket.emit('error', 'Aucune partie en cours');
        return;
      }

      if (party.etat !== 'VOTE_OUVERT') {
        socket.emit('error', 'Le vote n\'est pas ouvert');
        return;
      }

      if (!party.emetteurs || !party.emetteurs[socket.id]) {
        socket.emit('error', 'Vous n\'êtes pas un émetteur');
        return;
      }

      const v = parseInt(valeur, 10);
      if (isNaN(v) || v < 0 || v > 6) {
        socket.emit('error', 'Valeur invalide (0-6)');
        return;
      }

      party.votes = party.votes || {};
      party.votes[socket.id] = v;

      await saveParty(party);

      socket.emit('vote-confirmed', v);
      await broadcastToParty(party);
      console.log('Vote reçu de', socket.id, ':', v);
    } catch (err) {
      console.error('Erreur vote:', err);
      socket.emit('error', 'Erreur serveur');
    }
  });

  // Terminer la partie (Récepteur uniquement)
  socket.on('end-party', async () => {
    try {
      const code = await getUserParty(socket.id);
      const party = await getParty(code);

      if (!party || socket.id !== party.recepteurId) {
        socket.emit('error', 'Action non autorisée');
        return;
      }

      // Notifier tout le monde
      io.to(party.recepteurId).emit('party-ended');
      for (const odId of Object.keys(party.emetteurs || {})) {
        io.to(odId).emit('party-ended');
        await deleteUserParty(odId);
      }

      await deleteUserParty(socket.id);
      await deleteParty(code);

      io.to(socket.id).emit('party-state', null);
      io.to(socket.id).emit('role', null);

      console.log('Partie terminée:', code);
    } catch (err) {
      console.error('Erreur end-party:', err);
      socket.emit('error', 'Erreur serveur');
    }
  });

  // Déconnexion
  socket.on('disconnect', async () => {
    console.log('Utilisateur déconnecté:', socket.id);

    try {
      const code = await getUserParty(socket.id);
      if (!code) return;

      const party = await getParty(code);
      if (!party) {
        await deleteUserParty(socket.id);
        return;
      }

      // Si le récepteur se déconnecte, terminer la partie
      if (socket.id === party.recepteurId) {
        for (const odId of Object.keys(party.emetteurs || {})) {
          io.to(odId).emit('party-ended');
          await deleteUserParty(odId);
        }

        await deleteParty(code);
        await deleteUserParty(socket.id);
        console.log('Récepteur déconnecté, partie terminée:', code);
        return;
      }

      // Si un émetteur se déconnecte, le retirer
      if (party.emetteurs && party.emetteurs[socket.id]) {
        delete party.emetteurs[socket.id];
        if (party.votes) {
          delete party.votes[socket.id];
        }
        await saveParty(party);
        await deleteUserParty(socket.id);
        await broadcastToParty(party);
        console.log('Émetteur retiré:', socket.id, 'partie:', code);
      }
    } catch (err) {
      console.error('Erreur disconnect:', err);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
