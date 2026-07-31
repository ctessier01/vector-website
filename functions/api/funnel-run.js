/**
 * Cloudflare Pages Function — POST /api/funnel-run
 *
 * Exécute le mini-funnel de relance des lead magnets : envoie les courriels
 * J+3 et J+7 aux leads dont l'envoi est dû, puis marque l'envoi en base.
 *
 * Déclenché par un cron externe (GitHub Actions, horaire) parce que les
 * Pages Functions n'ont pas de déclencheur planifié natif.
 *
 * Pipeline :
 *   1. Authentification par secret partagé (en-tête X-Funnel-Secret)
 *   2. Garde-fou horaire : on n'envoie pas la nuit (fenêtre 9h-17h Est)
 *   3. Lecture de la vue vw_marketing_leads_funnel_due, qui contient TOUTE
 *      la logique de ciblage : quel courriel est dû, filtre des désabonnés,
 *      et la garantie LCAP de 14 jours. Cette logique reste volontairement
 *      dans la base : rien côté code ne peut la contourner.
 *   4. Pour chaque lead : envoi via Resend, puis marquage de la colonne
 *      correspondante. Le marquage est conditionnel (filtre is.null), donc
 *      deux exécutions simultanées ne peuvent pas produire deux envois.
 *   5. Si l'envoi échoue, on ne marque pas : la prochaine exécution réessaiera.
 *
 * Sécurité :
 *   - Le secret est comparé en temps constant.
 *   - Aucune donnée de lead n'est retournée dans la réponse (compteurs seuls).
 *
 * Variables d'environnement requises :
 *   - FUNNEL_CRON_SECRET          (secret) — doit correspondre à l'en-tête
 *   - RESEND_API_KEY              (secret)
 *   - SUPABASE_URL                (texte)
 *   - SUPABASE_SERVICE_ROLE_KEY   (secret)
 *   - IP_HASH_SECRET              (secret) — signe les liens de téléchargement
 *   - SITE_URL                    (texte)
 */

const DEFAULT_FROM = 'Vector <support@mail.vectorplanning.ai>';
const DEFAULT_REPLY_TO = 'support@vectorplanning.ai';

const BATCH_LIMIT = 40;          // leads traités par exécution
const TOKEN_TTL_DAYS = 30;
const SEND_WINDOW = { start: 9, end: 17, tz: 'America/Toronto' };

const EMAIL_SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";


/**
 * Contenu du funnel, par lead magnet.
 *
 * Un magnet absent de cette table n'envoie simplement AUCUNE relance : c'est
 * volontaire et sans risque (le pied de courriel promet « au maximum trois »,
 * jamais un nombre exact). Pour activer un nouvel ebook, ajouter son entrée.
 *
 * Un courriel dont cta_kind vaut 'download' reçoit un lien de téléchargement
 * signé, régénéré à la volée à partir du lead et de son source_form : le
 * bouton ouvre donc le guide du lecteur, pas une page générique.
 */
const FUNNEL_COPY = {
    'ebook_anti_surprise': {
        title_fr: 'Le système anti-surprise',
        title_en: 'The anti-surprise system',
        day3: {
            fr: {
                subject: 'Par où commencer dans le guide',
                cta: 'Ouvrir le guide',
                cta_kind: 'download',
                body: [
                    "Tu as téléchargé « Le système anti-surprise » il y a trois jours. Si tu ne l'as pas encore ouvert, aucun jugement : c'est exactement le genre de chose qui glisse quand la semaine est pleine.",
                    "Si tu veux un point d'entrée, commence par la deuxième étape : l'inventaire de capacité. C'est la plus courte du guide, et c'est elle qui donne son sens à la projection de la première. Elle tient en un calcul :"
                ],
                calc: ['40 heures théoriques par semaine', "moins 16 heures d'admin, de courriels, de transitions et d'imprévus", '= 24 heures réellement disponibles pour livrer'],
                after: [
                    'La plupart des solopreneurs planifient 40 heures de travail dans 24 heures de capacité.',
                    "Fais le calcul avec tes vrais chiffres, ça prend cinq minutes. Ta projection 14 jours se compare alors à un chiffre réel au lieu d'un chiffre imaginaire, et c'est à partir de là que tout le reste du système tient. Retiens ce nombre de 24 heures : on va y revenir."
                ],
                signoff: 'Bonne semaine,'
            },
            en: {
                subject: 'Where to start in the guide',
                cta: 'Open the guide',
                cta_kind: 'download',
                body: [
                    'You downloaded "The anti-surprise system" three days ago. If you haven\'t opened it yet, no judgment: that\'s exactly the kind of thing that slips when the week is full.',
                    'If you want an entry point, start with the second step: the capacity inventory. It\'s the shortest one in the guide, and it\'s what gives the first step\'s projection its meaning. It fits in one calculation:'
                ],
                calc: ['40 theoretical hours per week', 'minus 16 hours of admin, email, transitions and interruptions', '= 24 hours actually available to deliver'],
                after: [
                    'Most solopreneurs plan 40 hours of work into 24 hours of capacity.',
                    'Do the math with your real numbers, it takes five minutes. Your 14-day projection then compares against a real number instead of an imaginary one, and that\'s where the rest of the system starts to hold. Keep that 24-hour number in mind: we\'ll come back to it.'
                ],
                signoff: 'Have a good week,'
            }
        },
        day7: {
            fr: {
                subject: 'Les 20 minutes qui tiennent le système',
                cta: 'Ouvrir le guide',
                cta_kind: 'download',
                body: [
                    "Une semaine depuis le guide. Si tu as fait ton inventaire de capacité, tu sais maintenant combien d'heures tu as vraiment. Il reste à empêcher ce chiffre de vieillir.",
                    "C'est le rôle de la quatrième étape, le check-in du dimanche. Sans rituel hebdomadaire, ta projection 14 jours devient obsolète en quelques jours : elle finit par décrire une semaine qui n'existe plus. 20 minutes, trois questions :"
                ],
                calc: [
                    "qu'est-ce qui a glissé cette semaine, et où c'est atterri",
                    "qu'est-ce qui s'en vient dans 14 jours que je n'avais pas anticipé",
                    'est-ce que ma capacité réelle a changé'
                ],
                after: [
                    "Le moment compte autant que les questions. Le dimanche soir te donne assez de recul pour voir la semaine qui finit, et assez de proximité pour que l'ajustement serve à quelque chose. Si ton dimanche est sacré, bascule au lundi matin, avant de commencer à travailler. Jamais le vendredi en fin de journée : tu es fatigué, tu survoles, et tu repars le lundi avec un système non recalibré.",
                    "Une remarque tirée du guide, et c'est souvent la découverte du premier check-in : une tâche qui glisse trois fois de suite n'est pas une tâche en retard. C'est une tâche mal définie ou mal estimée."
                ],
                signoff: 'Bonne semaine,'
            },
            en: {
                subject: 'The 20 minutes that hold the system together',
                cta: 'Open the guide',
                cta_kind: 'download',
                body: [
                    "A week since the guide. If you've done your capacity inventory, you now know how many hours you actually have. What's left is keeping that number from going stale.",
                    "That's what the fourth step is for, the Sunday check-in. Without a weekly ritual, your 14-day projection goes stale within days: it ends up describing a week that no longer exists. 20 minutes, three questions:"
                ],
                calc: [
                    'what slipped this week, and where it landed',
                    "what's coming in the next 14 days that I hadn't anticipated",
                    'has my real capacity changed'
                ],
                after: [
                    "The timing matters as much as the questions. Sunday evening gives you enough distance to see the week that's ending, and enough proximity for the adjustment to count. If Sunday is sacred to you, move it to Monday morning, before you start working. Never Friday at the end of the day: you're tired, you skim, and you start the next week with a system that was never recalibrated.",
                    "One note from the guide, and it's often the first check-in's real discovery: a task that slips three times in a row isn't a task running late. It's a task that's poorly defined or poorly estimated."
                ],
                signoff: 'Have a good week,'
            }
        },
        day14: {
            fr: {
                subject: 'Quand la méthode commence à peser',
                cta: 'Rejoindre la liste d\'attente',
                cta_kind: 'site',
                body: [
                    "Déjà deux semaines depuis que tu as téléchargé « Le système anti-surprise ». Si tu as installé la projection 14 jours et pris l'habitude du check-in, tu as réglé la plus grande partie du problème.",
                    "Le guide se termine sur une idée que je veux te répéter, parce que c'est la question qu'on me pose le plus.",
                    "Le système manuel tient très bien à un ou deux projets. À partir de trois, ce n'est pas la méthode qui casse, c'est son coût d'entretien. Chaque projet ajouté ne coûte pas seulement son propre entretien : il coûte aussi la vérification de sa compatibilité avec tous les autres. À cinq projets, tu maintiens cinq plans mais tu vérifies dix paires d'interactions possibles.",
                    "Le guide chiffre ça à environ 2 h 30 par semaine. C'est plus de 10 % des 24 heures livrables que tu avais calculées, passées à organiser le travail plutôt qu'à le faire. Et la charge mentale de garder cinq projets en tête, elle, ne se chronomètre pas.",
                    "C'est pour ce moment précis qu'on a bâti Vector. Tu gardes la méthode, Arthur s'occupe de l'entretien : la projection se tient à jour toute seule, la capacité se calcule sur ton historique réel, et tu reçois une alerte dès qu'une échéance entre en zone à risque.",
                    "Vector ouvre au début de l'automne. En t'inscrivant à la liste d'attente maintenant, tu seras averti dès l'ouverture, et les 50 premières inscriptions obtiennent 21 jours d'essai du plan Accélération au lieu de 14, plus 100 crédits IA en cadeau."
                ],
                calc: null,
                after: ["Et si le manuel te suffit, garde-le, sincèrement. Le but du guide n'était pas de te vendre quelque chose, c'était de rendre tes semaines prévisibles."],
                signoff: 'À bientôt,'
            },
            en: {
                subject: 'When the method starts to weigh',
                cta: 'Join the waitlist',
                cta_kind: 'site',
                body: [
                    'Already two weeks since you downloaded "The anti-surprise system." If you\'ve set up the 14-day projection and built the check-in habit, you\'ve solved most of the problem.',
                    "The guide ends on an idea I want to repeat here, because it's the question I get most.",
                    "The manual system holds up very well at one or two projects. Past three, it isn't the method that breaks, it's its maintenance cost. Every project you add doesn't just cost its own upkeep: it also costs checking how it collides with all the others. At five projects, you maintain five plans but you check ten possible pairs of interactions.",
                    "The guide puts that at roughly two and a half hours a week. That's more than 10% of the 24 deliverable hours you calculated, spent organizing the work instead of doing it. And the mental load of holding five projects in your head doesn't show up on any clock.",
                    "That's exactly the moment we built Vector for. You keep the method, Arthur handles the upkeep: the projection stays current on its own, capacity is computed from your real history, and you get an alert as soon as a deadline enters the risk zone.",
                    "Vector opens in early fall. Joining the waitlist now means you hear about it the day we open, and the first 50 signups get a 21-day Acceleration trial instead of 14, plus 100 AI credits as a gift."
                ],
                calc: null,
                after: ["And if manual is enough for you, keep it, sincerely. The goal of the guide wasn't to sell you something, it was to make your weeks predictable."],
                signoff: 'Talk soon,'
            }
        }
    },
    'ebook_vendre_sans_travestir': {
        title_fr: 'Vendre sans te travestir',
        title_en: 'Selling Without Faking It',
        day3: {
            fr: {
                subject: "La phrase à préparer d'avance",
                cta: 'Ouvrir le guide',
                cta_kind: 'download',
                body: [
                    "Tu as téléchargé « Vendre sans te travestir » il y a trois jours. Si tu ne l'as pas encore ouvert, aucun jugement : c'est exactement le genre de chose qui glisse quand la semaine est pleine.",
                    "Si tu veux un point d'entrée, commence par le premier mouvement : la phrase claire. C'est le plus court du guide, et il règle la situation la plus fréquente, celle où on te demande ce que tu fais et où tu t'entends répondre trois phrases molles. Il tient en trois morceaux :"
                ],
                calc: [
                    "pour qui : le type de personne que tu aides, pas « tout le monde »",
                    "quel problème : ce que tu lui enlèves concrètement",
                    "quel résultat : ce à quoi son entreprise ressemble après"
                ],
                after: [
                    "Écris la tienne, puis dis-la à voix haute trois fois. Si elle sonne comme un slogan, enlève un mot. Elle doit sonner comme toi.",
                    "Ça donne quelque chose comme : « J'aide les designers indépendants à être payés à temps, surtout quand relancer un client les met mal à l'aise. » Il n'y a rien à vendre là-dedans, juste de quoi permettre à l'autre de savoir en cinq secondes s'il vient de rencontrer la bonne personne."
                ],
                signoff: 'Bonne semaine,'
            },
            en: {
                subject: 'The sentence to prepare in advance',
                cta: 'Open the guide',
                cta_kind: 'download',
                body: [
                    'You downloaded "Selling Without Faking It" three days ago. If you haven\'t opened it yet, no judgment: that\'s exactly the kind of thing that slips when the week is full.',
                    "If you want an entry point, start with the first move: the clear sentence. It's the shortest one in the guide, and it fixes the most common situation, the one where someone asks what you do and you hear yourself give three limp sentences. It fits in three pieces:"
                ],
                calc: [
                    'who for: the type of person you help, not "everyone"',
                    'what problem: what you remove or solve for them, concretely',
                    'what result: what their business looks like after'
                ],
                after: [
                    'Write yours, then say it out loud three times. If it sounds like a slogan, cut a word. It should sound like you.',
                    'It comes out something like: "I help independent designers get paid on time, especially when chasing a client makes them uncomfortable." There\'s nothing to sell in there, just enough for the other person to know in five seconds whether they just met the right person.'
                ],
                signoff: 'Have a good week,'
            }
        },
        day7: {
            fr: {
                subject: 'Les ventes ne se perdent pas sur un non',
                cta: 'Ouvrir le guide',
                cta_kind: 'download',
                body: [
                    "Une semaine depuis le guide. Si tu as ta phrase claire, l'entrée en matière est réglée. Il reste ce qui vient après, et c'est là que le plus de ventes se perdent.",
                    "La plupart ne se perdent pas sur un non. Elles se perdent sur un silence, un « je vais y penser » que personne ne relance. Le cinquième mouvement du guide règle ça avec une cadence courte et espacée, qui ne demande jamais deux fois la même chose :"
                ],
                calc: [
                    "J+2 : un mot court qui résume votre échange et laisse la décision ouverte",
                    "J+7 : une chose utile, une ressource ou un exemple, sans rien demander",
                    "J+21 : la porte laissée ouverte, « écris-moi si le moment revient »"
                ],
                after: [
                    "Trois relances, puis tu arrêtes. Respecter le non fait partie de la méthode, et c'est justement ce qui te rend facile à recommander.",
                    "Si tu as un « je vais y penser » qui traîne depuis quelques semaines, c'est le moment d'essayer ou de compléter ta série de relances."
                ],
                signoff: 'Bonne semaine,'
            },
            en: {
                subject: "Sales aren't lost on a no",
                cta: 'Open the guide',
                cta_kind: 'download',
                body: [
                    "A week since the guide. If you have your clear sentence, the opening is handled. What's left is what comes after, and that's where most sales are lost.",
                    'Most aren\'t lost on a no. They\'re lost in silence, an "I\'ll think about it" that nobody follows up on. The fifth move in the guide handles that with a short, spaced cadence that never asks for the same thing twice:'
                ],
                calc: [
                    'Day 2: a short note summing up your conversation, decision left open',
                    'Day 7: one useful thing, a resource or an example, asking for nothing',
                    'Day 21: the door left open, "write me if the timing comes back"'
                ],
                after: [
                    "Three follow-ups, then you stop. Respecting the no is part of the method, and it's exactly what makes you easy to recommend.",
                    'If you have an "I\'ll think about it" that\'s been sitting for a few weeks, this is the moment to start or finish your follow-up series.'
                ],
                signoff: 'Have a good week,'
            }
        },
        day14: {
            fr: {
                subject: 'Quand la constance devient le vrai travail',
                cta: 'Rejoindre la liste d\'attente',
                cta_kind: 'site',
                body: [
                    "Déjà deux semaines depuis que tu as téléchargé le guide « Vendre sans te travestir ». Si tu as écrit ta phrase claire et choisi tes trois canaux, tu as déjà fait le plus dur.",
                    "Le guide se termine sur une idée que je veux te répéter, parce que c'est là que la plupart des bonnes intentions de vente meurent.",
                    "Vendre au calme ne repose pas sur le talent, mais sur la constance : tes trois canaux tenus, tes relances faites à J+2, J+7 et J+21, mois après mois. Et c'est précisément ce que la charge mentale du solo fait échouer. Tu ne sautes pas une semaine par manque de volonté, tu la sautes parce que ta tête est déjà pleine du travail client.",
                    "C'est pour ce moment-là qu'on a bâti Vector. Tes trois canaux deviennent des tâches récurrentes tenues plutôt que des bonnes intentions, tes relances sont programmées et te reviennent au bon moment, et tu n'as plus à te demander à qui tu devais reparler. La conversation reste à toi, c'est la seule chose que personne ne peut faire à ta place.",
                    "Vector ouvre au début de l'automne. En t'inscrivant à la liste d'attente maintenant, tu seras averti dès l'ouverture, et les 50 premières inscriptions obtiennent 21 jours d'essai du plan Accélération au lieu de 14, plus 100 crédits IA en cadeau."
                ],
                calc: null,
                after: [
                    "Et si un carnet et un rappel sur ton téléphone suffisent à te tenir, garde-les, sincèrement. Le but du guide n'était pas de te vendre quelque chose, c'était de te débarrasser du personnage."
                ],
                signoff: 'À bientôt,'
            },
            en: {
                subject: 'When consistency becomes the real work',
                cta: 'Join the waitlist',
                cta_kind: 'site',
                body: [
                    'Already two weeks since you downloaded "Selling Without Faking It." If you\'ve written your clear sentence and picked your three channels, you\'ve already done the hard part.',
                    "The guide ends on an idea I want to repeat here, because it's where most good sales intentions die.",
                    "Selling calmly doesn't rest on talent, it rests on consistency: your three channels held, your follow-ups sent at day 2, day 7 and day 21, month after month. And that's exactly what the mental load of working solo breaks. You don't skip a week for lack of will, you skip it because your head is already full of client work.",
                    "That's the moment we built Vector for. Your three channels become recurring tasks that actually hold instead of good intentions, your follow-ups are scheduled and come back to you at the right time, and you stop wondering who you were supposed to get back to. The conversation stays yours, it's the one thing nobody can do for you.",
                    'Vector opens in early fall. Joining the waitlist now means you hear about it the day we open, and the first 50 signups get a 21-day Acceleration trial instead of 14, plus 100 AI credits as a gift.'
                ],
                calc: null,
                after: [
                    "And if a notebook and a phone reminder are enough to keep you on track, keep them, sincerely. The goal of the guide wasn't to sell you something, it was to get rid of the character."
                ],
                signoff: 'Talk soon,'
            }
        }
    }
};

/**
 * Rang du suivi dans la séquence, pour le pied de page.
 * Le courriel de livraison (J+0) n'est PAS un suivi : la numérotation
 * commence à J+3. Les colonnes `funnel_email_N_sent_at` gardent leur
 * décalage historique (1 = livraison, 2 = J+3, 3 = J+7, 4 = J+14).
 */
const RANG_SUIVI = {
    day3:  { fr: 'le premier de trois suivis',  en: 'the first of three follow-ups' },
    day7:  { fr: 'le deuxième de trois suivis', en: 'the second of three follow-ups' },
    day14: { fr: 'le dernier des trois suivis', en: 'the last of the three follow-ups' }
};

const COLONNE_ENVOI = {
    day3:  'funnel_email_2_sent_at',
    day7:  'funnel_email_3_sent_at',
    day14: 'funnel_email_4_sent_at'
};


export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        // ── 1. Authentification ───────────────────────────────────────
        if (!env.FUNNEL_CRON_SECRET) {
            console.error('Missing env var: FUNNEL_CRON_SECRET');
            return json({ error: 'Server configuration error' }, 500);
        }
        const provided = request.headers.get('X-Funnel-Secret') || '';
        if (!timingSafeEqual(provided, env.FUNNEL_CRON_SECRET)) {
            return json({ error: 'Forbidden' }, 403);
        }

        for (const k of ['RESEND_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'IP_HASH_SECRET']) {
            if (!env[k]) {
                console.error(`Missing env var: ${k}`);
                return json({ error: 'Server configuration error' }, 500);
            }
        }

        // ── 2. Garde-fou horaire ──────────────────────────────────────
        // On ne réveille personne à 3 h du matin. `force=1` sert aux tests.
        const url = new URL(request.url);
        const force = url.searchParams.get('force') === '1';
        const hour = localHour(SEND_WINDOW.tz);
        if (!force && (hour < SEND_WINDOW.start || hour >= SEND_WINDOW.end)) {
            return json({ ok: true, skipped: 'outside_send_window', local_hour: hour, sent: 0 });
        }

        const supabaseHeaders = {
            'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json'
        };

        // ── 3. Leads dus (toute la logique de ciblage vit dans la vue) ─
        const dueRes = await fetch(
            `${env.SUPABASE_URL}/rest/v1/vw_marketing_leads_funnel_due` +
            `?next_email_kind=not.is.null&limit=${BATCH_LIMIT}`,
            { headers: supabaseHeaders }
        );

        if (!dueRes.ok) {
            const body = await dueRes.text().catch(() => '');
            console.error('Supabase read error:', dueRes.status, body);
            return json({ error: 'Database error', status: dueRes.status }, 502);
        }

        const leads = await dueRes.json();
        if (!Array.isArray(leads) || leads.length === 0) {
            return json({ ok: true, due: 0, sent: 0, skipped: 0, failed: 0 });
        }

        // ── 4. Envois ─────────────────────────────────────────────────
        const siteUrl = env.SITE_URL || 'https://vectorplanning.ai';
        let sent = 0, skipped = 0, failed = 0;

        for (const lead of leads) {
            const step = normalizeStep(lead.next_email_kind);
            const magnet = FUNNEL_COPY[lead.source_form];

            // Magnet sans séquence rédigée : on ne relance pas.
            if (!magnet || !step || !magnet[step]) { skipped++; continue; }

            const lang = lead.lang === 'en' ? 'en' : 'fr';
            const copy = magnet[step][lang];
            if (!copy) { skipped++; continue; }

            const column = COLONNE_ENVOI[step];
            if (!column) { skipped++; continue; }

            try {
                // Vector n'est pas encore ouvert : le CTA « site » mène à la liste
                // d'attente de lancement. À l'ouverture, remettre `${siteUrl}/`.
                const pageSite = lang === 'en' ? '/en/launch-waitlist' : '/liste-attente-lancement';
                let ctaUrl = `${siteUrl}${pageSite}?utm_source=funnel&utm_medium=email&utm_campaign=${encodeURIComponent(lead.source_form)}&utm_content=${step}`;
                if (copy.cta_kind === 'download') {
                    const token = await generateDownloadToken({
                        leadId: lead.id, resourceKey: lead.source_form, lang, secret: env.IP_HASH_SECRET
                    });
                    ctaUrl = `${siteUrl}/api/download?token=${encodeURIComponent(token)}`;
                }
                const unsubUrl = `${siteUrl}/api/unsubscribe?token=${lead.unsubscribe_token}&lang=${lang}`;
                const guideTitle = lang === 'en' ? magnet.title_en : magnet.title_fr;

                const ok = await sendEmail({
                    env, lang, copy, ctaUrl, unsubUrl, guideTitle,
                    name: firstName(lead.name), to: lead.email,
                    step: step
                });
                if (!ok) { failed++; continue; }

                // Marquage conditionnel : la colonne doit encore être nulle.
                const nowIso = new Date().toISOString();
                const patch = {};
                patch[column] = nowIso;
                patch.last_email_sent_at = nowIso;
                patch.last_email_kind = step === 'day3' ? 'funnel_day3' : 'funnel_day7';

                const patchRes = await fetch(
                    `${env.SUPABASE_URL}/rest/v1/marketing_leads?id=eq.${lead.id}&${column}=is.null`,
                    { method: 'PATCH', headers: supabaseHeaders, body: JSON.stringify(patch) }
                );
                if (!patchRes.ok) {
                    // Courriel parti mais marquage échoué : on le signale fort,
                    // c'est le seul cas qui pourrait produire un doublon.
                    console.error(`MARK FAILED after send, lead ${lead.id}: ${patchRes.status}`);
                }
                sent++;
            } catch (err) {
                console.error(`Funnel send failed for lead ${lead.id}:`, err);
                failed++;
            }
        }

        return json({ ok: true, due: leads.length, sent, skipped, failed, local_hour: hour });

    } catch (err) {
        console.error('Unexpected error in funnel-run:', err);
        return json({ error: 'Internal error' }, 500);
    }
}


// ──────────────────────────────────────────────────────────────────────────
// Envoi
// ──────────────────────────────────────────────────────────────────────────

async function sendEmail({ env, lang, copy, ctaUrl, unsubUrl, guideTitle, name, to, step }) {
    const isEn = lang === 'en';
    const safeName = escapeHtml(name);

    const rang = (RANG_SUIVI[step] || RANG_SUIVI.day3)[isEn ? 'en' : 'fr'];
    const unsubLink = `<div style="margin-top:12px;"><a href="${unsubUrl}" style="color:#6b7290;text-decoration:underline;">${isEn ? 'Unsubscribe in one click' : 'Se désinscrire en un clic'}</a></div>`;
    const footer = isEn
        ? `You're receiving this email because you downloaded "${escapeHtml(guideTitle)}" on vectorplanning.ai. This is ${rang} related to that guide.${unsubLink}`
        : `Tu reçois ce courriel parce que tu as téléchargé « ${escapeHtml(guideTitle)} » sur vectorplanning.ai. C'est ${rang} liés à ce guide.${unsubLink}`;

    let bodyHtml = `          <p style="margin:0 0 1.2rem;">${isEn ? 'Hello' : 'Bonjour'} ${safeName},</p>\n`;
    for (const p of copy.body) bodyHtml += `          <p style="margin:0 0 1.2rem;">${escapeHtml(p)}</p>\n`;
    if (copy.calc) {
        bodyHtml += `          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 1.4rem;"><tr><td style="background:#10131A;border-left:4px solid #8BFF3C;border-radius:0 10px 10px 0;padding:16px 20px;font-family:${EMAIL_SANS};font-size:15px;line-height:1.7;color:#e7eaef;">`;
        bodyHtml += copy.calc.map((l, i) => (i === copy.calc.length - 1
            ? `<strong style="color:#8BFF3C;">${escapeHtml(l)}</strong>`
            : escapeHtml(l))).join('<br>');
        bodyHtml += `</td></tr></table>\n`;
    }
    for (const p of copy.after) bodyHtml += `          <p style="margin:0 0 1.2rem;">${escapeHtml(p)}</p>\n`;
    bodyHtml += ctaButton(ctaUrl, escapeHtml(copy.cta));
    bodyHtml += `          <p style="margin:0 0 0.3rem;">${escapeHtml(copy.signoff)}</p>\n`;
    bodyHtml += `          <p style="margin:0;"><strong>Chantal</strong> · Vector</p>`;

    const textParts = [`${isEn ? 'Hello' : 'Bonjour'} ${name},`, ''];
    for (const p of copy.body) textParts.push(p, '');
    if (copy.calc) textParts.push(...copy.calc, '');
    for (const p of copy.after) textParts.push(p, '');
    textParts.push(`${copy.cta} : ${ctaUrl}`, '', copy.signoff, 'Chantal · Vector', '', '---',
        isEn ? `Unsubscribe: ${unsubUrl}` : `Se désinscrire : ${unsubUrl}`);

    try {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: env.EBOOK_FROM || DEFAULT_FROM,
                to: [to],
                reply_to: env.EBOOK_REPLY_TO || DEFAULT_REPLY_TO,
                subject: copy.subject,
                html: emailShell(lang, bodyHtml, footer),
                text: textParts.join('\n'),
                headers: {
                    'List-Unsubscribe': `<${unsubUrl}>`,
                    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
                }
            })
        });
        if (!res.ok) {
            console.error('Resend error:', res.status, await res.text().catch(() => ''));
            return false;
        }
        return true;
    } catch (err) {
        console.error('Resend request failed:', err);
        return false;
    }
}


// ──────────────────────────────────────────────────────────────────────────
// Gabarit de marque (identique à ebook-request.js)
// ──────────────────────────────────────────────────────────────────────────

function emailShell(lang, bodyHtml, footerHtml) {
    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>Vector</title>
</head>
<body style="margin:0;padding:0;background:#F5F4EF;-webkit-text-size-adjust:100%;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F5F4EF;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(16,19,26,0.06),0 12px 32px rgba(16,19,26,0.07);">
        <tr><td style="background:#10131A;padding:24px 32px 22px;text-align:center;">
          <img src="https://vectorplanning.ai/${lang === 'en' ? 'vector-logo-email-en.png' : 'vector-logo-email.png'}" alt="${lang === 'en' ? 'Vector — AI plans. You deliver.' : "Vector — L'IA planifie. Toi tu accomplis."}" width="248" style="display:block;margin:0 auto;border:0;outline:none;width:248px;max-width:78%;height:auto;">
        </td></tr>
        <tr><td style="padding:32px;color:#1a1f2e;font-size:16px;line-height:1.65;font-family:${EMAIL_SANS};">
${bodyHtml}
        </td></tr>
        <tr><td style="padding:0 32px 28px;font-family:${EMAIL_SANS};">
          <div style="border-top:1px solid #ececec;padding-top:16px;font-size:12px;color:#6b7290;line-height:1.55;">${footerHtml}</div>
        </td></tr>
      </table>
      <div style="font-family:${EMAIL_SANS};font-size:11px;color:#9aa1b3;margin-top:16px;">Vector · vectorplanning.ai</div>
    </td></tr>
  </table>
</body>
</html>`;
}

function ctaButton(href, label) {
    return `          <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:1.8rem auto;"><tr>
            <td style="border-radius:10px;background:#8BFF3C;">
              <a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:15px 30px;font-family:${EMAIL_SANS};font-size:15px;font-weight:700;color:#10131A;text-decoration:none;border-radius:10px;">${label}</a>
            </td>
          </tr></table>\n`;
}


// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

// Accepte funnel_day10 (ancienne vue) et funnel_day7 (nouvelle) : la bascule
// SQL peut donc se faire avant ou après ce déploiement, sans interruption.
function normalizeStep(kind) {
    if (kind === 'funnel_day3') return 'day3';
    if (kind === 'funnel_day7' || kind === 'funnel_day10') return 'day7';
    if (kind === 'funnel_day14') return 'day14';
    return null;
}

function localHour(tz) {
    try {
        return parseInt(new Intl.DateTimeFormat('en-CA', {
            timeZone: tz, hour: '2-digit', hour12: false
        }).format(new Date()), 10);
    } catch (e) {
        return new Date().getUTCHours();
    }
}

function firstName(full) {
    const n = (full || '').trim().split(/\s+/)[0];
    return n || 'là';
}

function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

async function generateDownloadToken({ leadId, resourceKey, lang, secret }) {
    const payload = {
        l: leadId, r: resourceKey, lg: lang,
        e: Math.floor(Date.now() / 1000) + (TOKEN_TTL_DAYS * 86400)
    };
    const payloadB64 = base64urlEncode(JSON.stringify(payload));
    const sigBuf = await hmacSha256(payloadB64, secret);
    return `${payloadB64}.${base64urlEncode(new Uint8Array(sigBuf))}`;
}

async function hmacSha256(message, secret) {
    const key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
}

function base64urlEncode(input) {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
