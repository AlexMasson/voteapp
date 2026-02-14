/**
 * Test visuel Playwright — Ouvre de vrais navigateurs pour voir le flux en live.
 * 
 * 1 fenêtre Récepteur + 4 fenêtres Émetteurs, vote en temps réel.
 * 
 * Usage :
 *   node tests/visual-test.js                          (localhost:3000)
 *   TARGET_URL=https://voteapp-8dub.onrender.com node tests/visual-test.js
 */

const { chromium } = require('playwright');

const TARGET = process.env.TARGET_URL || 'http://localhost:3000';
const NB_EMETTEURS = 4;
const NB_TOURS = 3;
const SLOW = 800; // ms entre chaque action pour voir en live

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runVisualTest() {
  console.log(`\n🎯 Cible : ${TARGET}`);
  console.log(`👥 Émetteurs : ${NB_EMETTEURS}`);
  console.log(`🔄 Tours : ${NB_TOURS}`);
  console.log(`⏳ Slow mode : ${SLOW}ms\n`);

  // Lancer le navigateur en mode visible (headful)
  const browser = await chromium.launch({
    headless: false,
    slowMo: 100,
    args: ['--window-size=500,700'],
  });

  // --- 1. Fenêtre Récepteur ---
  console.log('1️⃣  Ouverture du Récepteur...');
  const ctxRecepteur = await browser.newContext({
    viewport: { width: 480, height: 680 },
    storageState: undefined,
  });
  const recepteur = await ctxRecepteur.newPage();
  await recepteur.goto(TARGET);
  await sleep(SLOW);

  // Cliquer sur "Démarrer une partie"
  await recepteur.click('#btn-start');
  await sleep(SLOW);

  // Récupérer le code de la partie
  await recepteur.waitForSelector('#party-code');
  await sleep(500);
  const partyCode = await recepteur.textContent('#party-code');
  console.log(`   ✅ Partie créée : ${partyCode}`);

  // --- 2. Fenêtres Émetteurs ---
  console.log(`\n2️⃣  Ouverture de ${NB_EMETTEURS} Émetteurs...`);
  const emetteurPages = [];

  for (let i = 0; i < NB_EMETTEURS; i++) {
    const prenom = ['Alice', 'Bob', 'Charlie', 'Diana'][i] || `User${i}`;
    
    // Chaque émetteur dans un contexte séparé (localStorage isolé)
    const ctx = await browser.newContext({
      viewport: { width: 380, height: 600 },
      storageState: undefined,
    });
    const page = await ctx.newPage();
    await page.goto(TARGET);
    await sleep(400);

    // Remplir le code et le prénom
    await page.fill('#input-code', partyCode);
    await page.fill('#input-nom', prenom);
    await sleep(300);
    await page.click('#btn-join');
    await sleep(SLOW);

    console.log(`   ✅ ${prenom} a rejoint`);
    emetteurPages.push({ page, prenom, ctx });
  }

  // --- 3. Fermer les portes ---
  console.log('\n3️⃣  Fermeture des portes...');
  await sleep(SLOW);
  await recepteur.click('#btn-close-doors');
  await sleep(SLOW * 1.5);

  // --- 4. Tours de vote ---
  for (let tour = 1; tour <= NB_TOURS; tour++) {
    console.log(`\n4️⃣  Tour ${tour}/${NB_TOURS} — Ouverture du vote...`);
    await recepteur.click('#btn-open-vote');
    await sleep(SLOW * 1.5);

    // Chaque émetteur vote une valeur différente (avec un délai pour le spectacle)
    for (let i = 0; i < emetteurPages.length; i++) {
      const { page, prenom } = emetteurPages[i];
      const valeur = (i + tour) % 7; // Varier les votes par tour

      // Attendre que les boutons de vote soient visibles
      try {
        await page.waitForSelector('.vote-btn', { state: 'visible', timeout: 10000 });
        await page.click(`.vote-btn[data-value="${valeur}"]`);
        console.log(`   🗳️  ${prenom} vote ${valeur}`);
        await sleep(SLOW);
      } catch {
        console.log(`   ⚠️  ${prenom} — boutons de vote non visibles`);
      }
    }

    // Attendre un peu puis fermer le vote
    await sleep(SLOW);
    
    // Cliquer sur "Fin du vote"
    try {
      await recepteur.waitForSelector('#btn-close-vote:not(.hidden)', { timeout: 5000 });
      await recepteur.click('#btn-close-vote');
    } catch {
      // Le bouton peut avoir un sélecteur différent selon l'état
      await recepteur.click('#btn-close-vote');
    }
    
    await sleep(SLOW * 2);

    // Lire la moyenne affichée
    try {
      const moyenne = await recepteur.textContent('#moyenne-recepteur');
      console.log(`   📊 Moyenne : ${moyenne}`);
    } catch {
      console.log(`   📊 Moyenne non affichée`);
    }
  }

  // --- 5. Test de reconnexion par pseudo ---
  console.log('\n5️⃣  Test de reconnexion — Alice ferme et rejoint avec le même pseudo...');
  const alicePage = emetteurPages[0].page;
  const aliceCtx = emetteurPages[0].ctx;
  
  // Alice ferme sa page (simule fermeture d'onglet)
  await alicePage.close();
  await aliceCtx.close();
  await sleep(SLOW * 2);
  console.log('   ❌ Alice a fermé son onglet (pastille rouge côté récepteur)');

  // Alice rouvre un NOUVEAU navigateur (nouveau contexte = pas de localStorage)
  const newAliceCtx = await browser.newContext({
    viewport: { width: 380, height: 600 },
    storageState: undefined,
  });
  const aliceReconn = await newAliceCtx.newPage();
  await aliceReconn.goto(TARGET);
  await sleep(SLOW);

  // Alice rejoint avec le même code et le même pseudo
  await aliceReconn.fill('#input-code', partyCode);
  await aliceReconn.fill('#input-nom', 'Alice');
  await sleep(300);
  await aliceReconn.click('#btn-join');
  console.log('   🔄 Alice rejoint avec le même pseudo...');
  await sleep(SLOW * 2);

  // Vérifier que Alice est sur l'écran émetteur
  try {
    await aliceReconn.waitForSelector('#screen-emetteur.active', { timeout: 10000 });
    console.log('   ✅ Alice reconnectée par pseudo !');
    emetteurPages[0] = { page: aliceReconn, prenom: 'Alice', ctx: newAliceCtx };
  } catch {
    console.log('   ⚠️  Reconnexion par pseudo non détectée');
    const activeScreen = await aliceReconn.evaluate(() => {
      const active = document.querySelector('.screen.active');
      return active ? active.id : 'none';
    });
    console.log(`   📌 Écran actif Alice: ${activeScreen}`);
    emetteurPages[0] = { page: aliceReconn, prenom: 'Alice', ctx: newAliceCtx };
  }

  // --- 6. Un dernier tour post-reconnexion ---
  console.log('\n6️⃣  Tour post-reconnexion...');
  await recepteur.click('#btn-open-vote');
  await sleep(SLOW * 1.5);

  for (let i = 0; i < emetteurPages.length; i++) {
    const { page, prenom } = emetteurPages[i];
    const valeur = (i * 2) % 7;
    try {
      await page.waitForSelector('.vote-btn', { state: 'visible', timeout: 10000 });
      await page.click(`.vote-btn[data-value="${valeur}"]`);
      console.log(`   🗳️  ${prenom} vote ${valeur}`);
      await sleep(SLOW);
    } catch {
      console.log(`   ⚠️  ${prenom} — impossible de voter`);
    }
  }

  await sleep(SLOW);
  try {
    await recepteur.waitForSelector('#btn-close-vote:not(.hidden)', { timeout: 5000 });
    await recepteur.click('#btn-close-vote');
  } catch {
    await recepteur.click('#btn-close-vote');
  }
  await sleep(SLOW * 2);

  try {
    const moyenne = await recepteur.textContent('#moyenne-recepteur');
    console.log(`   📊 Moyenne post-reco : ${moyenne}`);
  } catch {
    console.log('   📊 Moyenne non affichée');
  }

  // --- 7. Fin ---
  console.log('\n7️⃣  Fin de partie...');
  await recepteur.click('#btn-end-party');
  await sleep(SLOW * 3);

  console.log('\n✅ Test visuel terminé ! Les fenêtres restent ouvertes 15 secondes...');
  await sleep(15000);

  // Fermer tout
  await browser.close();
  console.log('🏁 Navigateurs fermés.');
  process.exit(0);
}

runVisualTest().catch(err => {
  console.error('\n❌ ERREUR:', err.message);
  process.exit(1);
});
