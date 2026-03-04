/**
 * Smoke test — Simule 1 récepteur + 20 émetteurs, 5 tours de vote.
 * Vérifie qu'aucun vote n'est perdu et que la reconnexion fonctionne.
 *
 * Usage :
 *   TARGET_URL=https://your-app.onrender.com node tests/smoke-test.js
 *   node tests/smoke-test.js  (défaut: http://localhost:3000)
 */

const { io } = require('socket.io-client');

const TARGET = process.env.TARGET_URL || 'http://localhost:3000';
const NB_EMETTEURS = 20;
const NB_TOURS = 5;
const TIMEOUT = 300000; // 5 min timeout global (Redis REST API adds ~200ms per call)

console.log(`\n🎯 Cible : ${TARGET}`);
console.log(`👥 Émetteurs : ${NB_EMETTEURS}`);
console.log(`🔄 Tours : ${NB_TOURS}\n`);

function createSocket() {
  return io(TARGET, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
}

function waitFor(socket, event, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

// Attendre un party-state spécifique (par condition)
function waitForState(socket, conditionFn, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for state condition')), timeoutMs);
    const handler = (state) => {
      if (state && conditionFn(state)) {
        clearTimeout(timer);
        socket.removeListener('party-state', handler);
        resolve(state);
      }
    };
    socket.on('party-state', handler);
  });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runTest() {
  const startTime = Date.now();
  let partyCode = null;
  let totalVotesExpected = 0;
  let totalVotesReceived = 0;
  const errors = [];

  // --- 1. Créer le récepteur ---
  console.log('1️⃣  Création du récepteur...');
  const recepteur = createSocket();
  const recepteurOdId = 'test-recepteur-' + Date.now();

  await waitFor(recepteur, 'connect');
  recepteur.emit('start-party', recepteurOdId);
  partyCode = await waitFor(recepteur, 'party-code');
  console.log(`   ✅ Partie créée : ${partyCode}`);

  // --- 2. Connecter les émetteurs ---
  console.log(`2️⃣  Connexion de ${NB_EMETTEURS} émetteurs...`);
  const emetteurs = [];

  for (let i = 0; i < NB_EMETTEURS; i++) {
    const s = createSocket();
    const odId = `test-emetteur-${i}-${Date.now()}`;
    await waitFor(s, 'connect');
    s.emit('join-party', { code: partyCode, nom: `User${i}`, odId });
    await waitFor(s, 'role');
    emetteurs.push({ socket: s, odId, nom: `User${i}` });
  }
  console.log(`   ✅ ${NB_EMETTEURS} émetteurs connectés`);

  // --- 3. Fermer les portes ---
  console.log('3️⃣  Fermeture des portes...');
  recepteur.emit('close-doors');
  await sleep(500);

  // --- 4. Tours de vote ---
  for (let tour = 1; tour <= NB_TOURS; tour++) {
    console.log(`\n4️⃣  Tour ${tour}/${NB_TOURS} — Ouverture du vote...`);
    recepteur.emit('open-vote');
    await sleep(300);

    // Tous les émetteurs votent quasi-simultanément
    const votePromises = emetteurs.map((em, i) => {
      const valeur = i % 7; // 0-6
      totalVotesExpected++;
      return new Promise((resolve, reject) => {
        const voteTimeout = setTimeout(() => {
          errors.push(`Tour ${tour}: ${em.nom} — timeout vote-confirmed (valeur=${valeur})`);
          resolve(); // resolve quand même pour ne pas bloquer
        }, 60000);

        em.socket.once('vote-confirmed', (v) => {
          clearTimeout(voteTimeout);
          totalVotesReceived++;
          if (v !== valeur) {
            errors.push(`Tour ${tour}: ${em.nom} a voté ${valeur} mais reçu confirmation ${v}`);
          }
          resolve();
        });

        em.socket.once('error', (msg) => {
          clearTimeout(voteTimeout);
          errors.push(`Tour ${tour}: ${em.nom} — erreur serveur: ${msg}`);
          resolve();
        });

        // Petit décalage aléatoire (0-50ms) pour simuler le réel
        setTimeout(() => em.socket.emit('vote', valeur), Math.random() * 50);
      });
    });

    await Promise.all(votePromises);
    const votesThisTour = totalVotesReceived - (totalVotesExpected - NB_EMETTEURS);
    console.log(`   ✅ ${votesThisTour}/${NB_EMETTEURS} votes confirmés`);

    // Fermer le vote — attendre un state avec etat=VOTE_FERME
    recepteur.emit('close-vote');
    const state = await waitForState(recepteur, s => s.etat === 'VOTE_FERME');

    console.log(`   📊 Moyenne : ${state.moyenne} (${state.nbVotes} votes comptés)`);
    if (state.nbVotes !== NB_EMETTEURS) {
      errors.push(`Tour ${tour}: attendu ${NB_EMETTEURS} votes, reçu ${state.nbVotes}`);
    }

    // Vérifier voteMin / voteMax dans l'historique
    const lastHist = state.historique[state.historique.length - 1];
    if (lastHist.voteMin === undefined || lastHist.voteMax === undefined) {
      errors.push(`Tour ${tour}: voteMin/voteMax manquants dans l'historique`);
    } else {
      console.log(`   📈 Min: ${lastHist.voteMin}, Max: ${lastHist.voteMax}`);
    }

    // Vérifier cumulLast4
    if (state.cumulLast4 === undefined || state.cumulLast4 === null) {
      errors.push(`Tour ${tour}: cumulLast4 manquant dans le state`);
    } else {
      const expectedCount = Math.min(tour, 4);
      if (state.cumulLast4Count !== expectedCount) {
        errors.push(`Tour ${tour}: cumulLast4Count attendu ${expectedCount}, reçu ${state.cumulLast4Count}`);
      }
      console.log(`   🔢 Cumul 4 derniers: ${state.cumulLast4} (${state.cumulLast4Count}/4)`);
    }

    // Vérifier que l'historique ne dépasse jamais 8 entrées
    if (state.historique.length > 8) {
      errors.push(`Tour ${tour}: historique dépasse 8 entrées (${state.historique.length})`);
    }

    await sleep(200);
  }

  // --- 5. Test de reconnexion (vérifier que le statut connecté est correct) ---
  console.log('\n5️⃣  Test de reconnexion par pseudo...');
  const testEmetteur = emetteurs[0];
  testEmetteur.socket.disconnect();
  await sleep(2000); // Plus de temps sur Render pour traiter la déconnexion

  // Reconnecter avec le même pseudo via join-party
  const reconnSocket = createSocket();
  reconnSocket.on('error', (msg) => console.log('   ⚠️  error reçu:', msg));
  await waitFor(reconnSocket, 'connect');
  console.log(`   🔌 Socket reconnecté, envoi join-party (nom=${testEmetteur.nom}, code=${partyCode})`);
  reconnSocket.emit('join-party', { code: partyCode, nom: testEmetteur.nom, odId: `reco-${Date.now()}` });
  
  try {
    const role = await waitFor(reconnSocket, 'role', 60000);
    if (role === 'emetteur') {
      console.log('   ✅ Reconnexion par pseudo réussie');
      testEmetteur.socket = reconnSocket;
    } else {
      errors.push('Reconnexion échouée: rôle reçu = ' + role);
      console.log('   ❌ Reconnexion échouée, rôle:', role);
    }
  } catch (e) {
    errors.push('Reconnexion échouée: timeout role après 60s');
    console.log('   ❌ Timeout reconnexion — skip le tour post-reco');
    reconnSocket.disconnect();
    // Skip le tour post-reco
    console.log('\n7️⃣  Fin de partie...');
    recepteur.emit('end-party');
    await sleep(500);
    recepteur.disconnect();
    emetteurs.forEach(em => em.socket.disconnect());
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n' + '='.repeat(50));
    console.log(`⏱️  Durée : ${elapsed}s`);
    console.log(`📬 Votes envoyés : ${totalVotesExpected}`);
    console.log(`📩 Votes confirmés : ${totalVotesReceived}`);
    console.log(`\n❌ ${errors.length} ERREUR(S) :`);
    errors.forEach(e => console.log(`   - ${e}`));
    process.exit(1);
  }

  // --- 6. Tour de vote post-reconnexion ---
  console.log('\n6️⃣  Tour post-reconnexion...');
  recepteur.emit('open-vote');
  await sleep(300);

  const postRecoVotes = emetteurs.map((em, i) => {
    const valeur = (i + 3) % 7;
    totalVotesExpected++;
    return new Promise((resolve) => {
      const voteTimeout = setTimeout(() => {
        errors.push(`Post-reco: ${em.nom} — timeout vote-confirmed`);
        resolve();
      }, 60000);

      em.socket.once('vote-confirmed', () => {
        clearTimeout(voteTimeout);
        totalVotesReceived++;
        resolve();
      });

      em.socket.once('error', (msg) => {
        clearTimeout(voteTimeout);
        errors.push(`Post-reco: ${em.nom} — erreur serveur: ${msg}`);
        resolve();
      });

      setTimeout(() => em.socket.emit('vote', valeur), Math.random() * 50);
    });
  });

  await Promise.all(postRecoVotes);
  recepteur.emit('close-vote');
  const finalState = await waitForState(recepteur, s => s.etat === 'VOTE_FERME');
  console.log(`   📊 Moyenne post-reco : ${finalState?.moyenne} (${finalState?.nbVotes} votes)`);

  if (finalState?.nbVotes !== NB_EMETTEURS) {
    errors.push(`Post-reco: attendu ${NB_EMETTEURS} votes, reçu ${finalState?.nbVotes}`);
  }

  // Vérifier voteMin/voteMax du tour post-reco
  const lastHistPR = finalState?.historique?.[finalState.historique.length - 1];
  if (lastHistPR && lastHistPR.voteMin !== undefined) {
    console.log(`   📈 Min: ${lastHistPR.voteMin}, Max: ${lastHistPR.voteMax}`);
  } else {
    errors.push('Post-reco: voteMin/voteMax manquants');
  }

  // Vérifier que l'émetteur reconnecté est bien marqué connecté (race condition fix)
  const reconEmetteur = finalState?.emetteurs?.find(e => e.nom === testEmetteur.nom);
  if (reconEmetteur && !reconEmetteur.connecte) {
    errors.push('Race condition reconnexion: émetteur marqué déconnecté malgré reconnexion');
    console.log('   ❌ Race condition: émetteur déconnecté malgré reconnexion');
  } else if (reconEmetteur) {
    console.log('   ✅ Statut connecté correct après reconnexion');
  }

  // Historique total = 5 tours + 1 post-reco = 6 (doit être ≤ 8)
  console.log(`   📋 Historique: ${finalState?.historique?.length} entrées (max 8)`);
  if (finalState?.historique?.length > 8) {
    errors.push(`Post-reco: historique dépasse 8 (${finalState.historique.length})`);
  }

  // --- 7. Terminer ---
  console.log('\n7️⃣  Fin de partie...');
  recepteur.emit('end-party');
  await sleep(500);

  // Déconnecter tout le monde
  recepteur.disconnect();
  emetteurs.forEach(em => em.socket.disconnect());

  // --- Résumé ---
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(50));
  console.log(`⏱️  Durée : ${elapsed}s`);
  console.log(`📬 Votes envoyés : ${totalVotesExpected}`);
  console.log(`📩 Votes confirmés : ${totalVotesReceived}`);
  console.log(`🔄 Reconnexion : testée`);

  if (errors.length > 0) {
    console.log(`\n❌ ${errors.length} ERREUR(S) :`);
    errors.forEach(e => console.log(`   - ${e}`));
    process.exit(1);
  } else {
    console.log('\n✅ TOUS LES TESTS PASSENT');
    process.exit(0);
  }
}

// Timeout global
const globalTimeout = setTimeout(() => {
  console.error('\n❌ TIMEOUT GLOBAL DÉPASSÉ');
  process.exit(1);
}, TIMEOUT);

runTest().catch(err => {
  console.error('\n❌ ERREUR FATALE:', err.message);
  process.exit(1);
}).finally(() => clearTimeout(globalTimeout));
